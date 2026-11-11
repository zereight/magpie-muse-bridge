import { spawn } from "node:child_process"
import { createHash, randomUUID, timingSafeEqual } from "node:crypto"
import fs from "node:fs"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { MuseSdkRuntime } from "./sdk-runtime.mjs"
import { createMuseAuth, isMuseLoginPending } from "./muse-auth.mjs"
import { createMuseUsage } from "./muse-usage.mjs"

const PROVIDER_ID = "muse-bridge"
const TRANSPORT = process.env.MUSE_BRIDGE_TRANSPORT || "sdk"
const MCP_SERVER_NAME = "magpie"
const MCP_TOOL_PREFIX = `mcp__${MCP_SERVER_NAME}__`
const MCP_SERVER_PATH = fileURLToPath(new URL("./mcp-server.mjs", import.meta.url))
const NPM_ANTHROPIC = "@ai-sdk/anthropic"
const IDLE_MS = 30 * 60 * 1000
const MAX_CONVS = 32
const MAX_ACTIVE = positiveTimeout(process.env.MUSE_BRIDGE_MAX_ACTIVE, 4)
const TURN_TIMEOUT_MS = positiveTimeout(process.env.MUSE_BRIDGE_TURN_TIMEOUT_MS, 10 * 60 * 1000)
const TOOL_RESULT_TIMEOUT_MS = positiveTimeout(process.env.MUSE_BRIDGE_TOOL_TIMEOUT_MS, 30 * 60 * 1000)
const FIRST_EVENT_GATE_MS = positiveTimeout(process.env.MUSE_BRIDGE_FIRST_EVENT_MS, 15_000)
const TOOL_BATCH_MS = positiveTimeout(process.env.MUSE_BRIDGE_TOOL_BATCH_MS, 250)
const EXIT_GRACE_MS = 5_000
const STDERR_TAIL = 32 * 1024
const CONTROL_LINE_LIMIT = 16 * 1024 * 1024
const PING_INTERVAL_MS = 15_000
const EFFORT_ORDER = ["minimal", "low", "medium", "high", "xhigh", "max"]
const ALL_EFFORTS = ["minimal", "low", "medium", "high", "xhigh", "max"]

// Muse Code's public catalog (as CLIProxyAPI lists it). The CLI resolves the
// id itself, so an id the user types that is not here is passed through.
const MODELS = [
  { id: "muse-wonder-full-1.0", name: "Muse Wonder Full 1.0", context: 1007997, output: 128000, efforts: ALL_EFFORTS },
  { id: "muse-wonder-1.0", name: "Muse Wonder 1.0", context: 1007997, output: 128000, efforts: ALL_EFFORTS },
  { id: "muse-ember-1.0", name: "Muse Ember 1.0", context: 1007997, output: 128000, efforts: ALL_EFFORTS },
  { id: "muse-spark-1.3", name: "Muse Spark 1.3", context: 1048576, output: 65536, efforts: ALL_EFFORTS },
  { id: "muse-spark-1.2", name: "Muse Spark 1.2", context: 1048576, output: 65536, efforts: ALL_EFFORTS.slice(0, 5) },
]

const pool = new Map()
const liveTurns = new Set()
// Include hosts already closing after reset/eviction: they no longer have a
// conv.runtime pointer but still need synchronous cleanup if the plugin exits.
const sdkRuntimes = new Set()
const sessions = new Map()
const toolCalls = new Map()
let cachedMusePath
let controlServer
let controlServerPromise
let bridgeRoot

function positiveTimeout(value, fallback) {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

function findMuse() {
  if (cachedMusePath) return cachedMusePath
  const candidates = []
  if (process.env.MUSE_PATH) candidates.push(process.env.MUSE_PATH)
  for (const dir of (process.env.PATH || "").split(path.delimiter)) {
    if (dir) candidates.push(path.join(dir, "muse"))
  }
  candidates.push(path.join(os.homedir(), ".local", "bin", "muse"), "/usr/local/bin/muse", "/opt/homebrew/bin/muse")
  for (const candidate of candidates) {
    try {
      fs.accessSync(candidate, fs.constants.X_OK)
      if (!fs.statSync(candidate).isFile()) continue
      cachedMusePath = candidate
      return candidate
    } catch {}
  }
  return null
}

// The user's own muse config directory: where `muse login` keeps auth.json.
function realConfigHome() {
  return process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config")
}

function realAuthPath() {
  return process.env.MUSE_AUTH_PATH || path.join(realConfigHome(), "muse", "auth.json")
}

function ensureBridgeRoot() {
  if (bridgeRoot && fs.existsSync(bridgeRoot)) return bridgeRoot
  bridgeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "magpie-muse-bridge-"))
  fs.chmodSync(bridgeRoot, 0o700)
  return bridgeRoot
}

// Each conversation gets its own XDG homes so muse loads only the bridge's
// MCP server (not the user's settings.json, whose endpoint_transport Magpie
// may have pointed at its own gateway), keeps its sessions out of the user's
// resume list, and still signs in with the user's auth.json via a symlink.
function linkAuth(configHome) {
  const dir = path.join(configHome, "muse")
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  const link = path.join(dir, "auth.json")
  try { fs.rmSync(link, { force: true }) } catch {}
  fs.symlinkSync(realAuthPath(), link)
}

// muse may replace auth.json (atomic rename over the symlink) when it rewrites
// the credential. Carry that back to the user's file and restore the link.
function syncAuth(configHome) {
  const link = path.join(configHome, "muse", "auth.json")
  let stat
  try { stat = fs.lstatSync(link) } catch {
    try { linkAuth(configHome) } catch {}
    return
  }
  if (stat.isSymbolicLink()) return
  try {
    const text = fs.readFileSync(link, "utf8")
    const parsed = JSON.parse(text)
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const target = realAuthPath()
      let previous = null
      try { previous = fs.readFileSync(target, "utf8") } catch {}
      if (previous !== text) {
        fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 })
        const tmp = `${target}.muse-bridge-${process.pid}-${randomUUID()}`
        fs.writeFileSync(tmp, text, { mode: 0o600 })
        fs.renameSync(tmp, target)
      }
    }
  } catch {}
  try { linkAuth(configHome) } catch {}
}

function museEnv(dirs) {
  const env = { ...process.env }
  env.XDG_CONFIG_HOME = dirs.config
  env.XDG_DATA_HOME = dirs.data
  env.XDG_STATE_HOME = dirs.state
  env.MUSE_AUTH_PATH = realAuthPath()
  env.MUSE_LOGIN = "0"
  return env
}

function makeDirs(base) {
  const dirs = {
    base,
    config: path.join(base, "config"),
    data: path.join(base, "data"),
    state: path.join(base, "state"),
    work: path.join(base, "workspace"),
  }
  for (const dir of [dirs.base, dirs.config, dirs.data, dirs.state, dirs.work]) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  }
  linkAuth(dirs.config)
  return dirs
}

function execOnce(file, args, opts = {}) {
  return new Promise((resolve) => {
    let child
    try {
      child = spawn(file, args, { stdio: ["ignore", "pipe", "pipe"], ...opts })
    } catch (err) {
      resolve({ err, stdout: "", stderr: "", code: null, timedOut: false })
      return
    }
    let stdout = ""
    let stderr = ""
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      try { child.kill("SIGKILL") } catch {}
    }, opts.timeoutMs ?? 30_000)
    child.stdout.on("data", (data) => { stdout += data })
    child.stderr.on("data", (data) => { stderr += data })
    child.on("error", (err) => {
      clearTimeout(timer)
      resolve({ err, stdout, stderr, code: null, timedOut })
    })
    child.on("close", (code) => {
      clearTimeout(timer)
      resolve({ err: null, stdout, stderr, code, timedOut })
    })
  })
}

function requestedEffort(body) {
  const thinking = body.thinking?.type
  const direct = String(body.output_config?.effort || "").toLowerCase()
  if (direct === "ultra") return "max"
  if (EFFORT_ORDER.includes(direct)) return direct
  if (thinking !== "enabled" && thinking !== "adaptive") return ""
  const budget = Number(body.thinking?.budget_tokens)
  if (!Number.isFinite(budget) || budget <= 0) return ""
  if (budget <= 4096) return "low"
  if (budget <= 12000) return "medium"
  if (budget <= 24000) return "high"
  return "xhigh"
}

function closestEffort(effort, efforts) {
  const target = EFFORT_ORDER.indexOf(effort)
  let best = efforts[0]
  for (const candidate of efforts.slice(1)) {
    const distance = Math.abs(EFFORT_ORDER.indexOf(candidate) - target)
    const bestDistance = Math.abs(EFFORT_ORDER.indexOf(best) - target)
    if (distance < bestDistance || distance === bestDistance && EFFORT_ORDER.indexOf(candidate) > EFFORT_ORDER.indexOf(best)) {
      best = candidate
    }
  }
  return best
}

function resolveModel(requested, body) {
  const known = MODELS.find((model) => model.id === requested)
  const effort = requestedEffort(body)
  if (!effort) return { model: requested, effort: "" }
  return { model: requested, effort: known ? closestEffort(effort, known.efforts) : effort }
}

class BusyError extends Error {
  constructor(message) {
    super(message)
    this.statusCode = 503
  }
}

class UnsupportedContent extends Error {
  constructor(what) {
    super(`muse bridge: ${what} is not supported`)
    this.statusCode = 400
  }
}

class Conv {
  constructor(convKey) {
    this.convKey = convKey
    this.dirs = makeDirs(path.join(ensureBridgeRoot(), randomUUID()))
    this.token = randomUUID()
    this.sessionId = null
    this.runtime = null
    this.runtimeClosing = Promise.resolve()
    this.toolsSignature = null
    this.model = null
    this.workDir = null
    this.expected = null
    this.turn = null
    this.lastUsed = Date.now()
    this.disposed = false
    sessions.set(this.token, this)
  }

  matchesHistory(messages) {
    return this.expected != null && historyKey(this.expected) === historyKey(messages)
  }

  reset() {
    this.sessionId = null
    this.expected = null
    if (this.runtime) {
      const runtime = this.runtime
      this.runtime = null
      this.runtimeClosing = runtime.close().then(() => syncAuth(this.dirs.config))
        .finally(() => sdkRuntimes.delete(runtime))
    }
  }

  recordAssistant(turn, content) {
    if (this.turn === turn && this.expected) this.expected.push({ role: "assistant", content })
  }

  recordToolResults(turn, messages) {
    if (this.turn === turn) this.expected = messages.map((message) => ({ ...message }))
  }

  startTurn(opts) {
    if (this.turn) throw new BusyError("muse bridge: this conversation still has an unfinished response")
    if (TRANSPORT === "exec" && !this.sessionId) this.sessionId = randomUUID()
    const turn = TRANSPORT === "sdk" ? new SdkTurn(this, opts) : new Turn(this, opts)
    this.turn = turn
    this.expected = opts.messages.map((message) => ({ ...message }))
    this.lastUsed = Date.now()
    try {
      turn.start()
    } catch (error) {
      turn.finalize()
      throw error
    }
    return turn
  }

  dispose() {
    if (this.disposed) return
    this.disposed = true
    this.turn?.finalize()
    this.reset()
    sessions.delete(this.token)
    if (pool.get(this.convKey) === this) pool.delete(this.convKey)
    this.runtimeClosing.then(() => fs.promises.rm(this.dirs.base, { recursive: true, force: true })).catch(() => {})
  }
}

class Turn {
  constructor(conv, opts) {
    this.conv = conv
    this.sessionId = conv.sessionId
    this.musePath = opts.musePath
    this.prompt = opts.prompt
    this.body = opts.body
    this.images = opts.images
    this.tools = opts.tools
    this.toolsSignature = stableJSON(opts.tools)
    this.model = opts.model
    this.effort = opts.effort
    this.dir = path.join(conv.dirs.base, "turns", randomUUID())
    this.events = []
    this.waiters = []
    this.calls = []
    this.attached = false
    this.done = false
    this.finalized = false
    this.exited = false
    this.child = null
    this.stdoutBuf = ""
    this.stderrTail = ""
    this.runId = null
    this.sawText = false
    this.terminal = null
    this.usage = null
    this.timer = null
    this.graceTimer = null
    this.firstResolve = null
    this.first = new Promise((resolve) => { this.firstResolve = resolve })
  }

  start() {
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 })
    const promptFile = path.join(this.dir, "prompt.txt")
    fs.writeFileSync(promptFile, this.prompt, { mode: 0o600 })
    const imageFiles = this.images.map((image, index) => {
      const file = path.join(this.dir, `image-${index}.${image.ext}`)
      fs.writeFileSync(file, Buffer.from(image.data, "base64"), { mode: 0o600 })
      return file
    })
    writeSettings(this.conv, this.tools.length > 0)

    const args = [
      "exec", "--json",
      "--session-id", this.sessionId,
      "--prompt-file", promptFile,
      "--preset", "empty",
      "--disable-shell", "--disable-write", "--disable-web-tools",
      "--disable-request-user-input", "--disable-reminders",
      "--no-foreign-personal-context",
      "--approval-mode", "never",
      "--approval-judge", "off",
      "--contributor-mode", "off",
      "-w", "off",
    ]
    if (process.env.MUSE_BRIDGE_BASE_URL) args.push("--base-url", process.env.MUSE_BRIDGE_BASE_URL)
    if (this.model) args.push("--model", this.model)
    if (this.effort) args.push("--reasoning-effort", this.effort)
    for (const file of imageFiles) args.push("--image", file)

    this.child = spawn(this.musePath, args, {
      cwd: this.conv.dirs.work,
      stdio: ["ignore", "pipe", "pipe"],
      env: museEnv(this.conv.dirs),
    })
    liveTurns.add(this)
    this.child.on("error", (error) => this.#onExit(null, null, error))
    this.child.on("close", (code, signal) => this.#onExit(code, signal, null))
    this.child.stderr.setEncoding("utf8")
    this.child.stderr.on("data", (data) => {
      this.stderrTail = (this.stderrTail + data).slice(-STDERR_TAIL)
    })
    this.child.stdout.setEncoding("utf8")
    this.child.stdout.on("data", (data) => {
      this.stdoutBuf += data
      for (;;) {
        const newline = this.stdoutBuf.indexOf("\n")
        if (newline < 0) break
        const line = this.stdoutBuf.slice(0, newline)
        this.stdoutBuf = this.stdoutBuf.slice(newline + 1)
        this.#onLine(line)
      }
    })
    this.#arm()
  }

  #onLine(line) {
    if (!line.trim()) return
    let event
    try { event = JSON.parse(line) } catch { return }
    this.#arm()
    const type = event.payload_type
    const payload = event.payload || {}
    const run = payload.run_stream?.id
    if (type === "run.lifecycle.started" && !this.runId && run) this.runId = run
    if (this.runId && run && run !== this.runId) return
    if (type === "run.output.delta") {
      if (typeof payload.text === "string" && payload.text) {
        this.sawText = true
        this.push({ type: "text", text: payload.text })
      }
    } else if (type === "run.usage") {
      this.usage = payload
    } else if (typeof type === "string" && type.startsWith("run.terminal.")) {
      this.terminal = payload
      clearTimeout(this.graceTimer)
      this.graceTimer = setTimeout(() => this.kill(), EXIT_GRACE_MS)
      this.graceTimer.unref?.()
    }
  }

  #onExit(code, signal, error) {
    if (this.exited) return
    this.exited = true
    clearTimeout(this.timer)
    clearTimeout(this.graceTimer)
    liveTurns.delete(this)
    if (this.stdoutBuf.trim()) this.#onLine(this.stdoutBuf)
    this.stdoutBuf = ""
    syncAuth(this.conv.dirs.config)
    fs.promises.rm(this.dir, { recursive: true, force: true }).catch(() => {})
    const completed = this.terminal?.terminal === "completed"
    if (!completed && this.conv.sessionId === this.sessionId) this.conv.reset()
    if (completed) {
      this.#complete()
      return
    }
    let message
    if (error) message = `muse bridge: could not run muse: ${error.message}`
    else if (this.terminal) message = `muse run ${this.terminal.terminal}: ${this.terminal.reason || this.terminal.text || "(no reason given)"}`
    else {
      const tail = this.stderrTail.split("\n").filter((line) => line.trim() && !/^muse:\s+(?:Skills:|.*skill|Agent delegation)/i.test(line)).slice(-6).join("\n")
      message = `muse exited (code=${code} signal=${signal})${tail ? ": " + tail : ""}`
    }
    this.fail(new Error(message))
    if (!this.attached) this.finalize()
  }

  #complete() {
    if (this.done) return
    this.done = true
    this.push({ type: "result", text: this.sawText ? "" : this.terminal?.text || "", usage: this.usage })
  }

  fail(error) {
    if (this.done) return
    this.done = true
    this.push({ type: "error", error })
  }

  #arm() {
    clearTimeout(this.timer)
    if (this.exited) return
    const waiting = this.calls.some((call) => !call.responded)
    const timeout = waiting ? TOOL_RESULT_TIMEOUT_MS : TURN_TIMEOUT_MS
    this.timer = setTimeout(() => {
      const what = waiting ? "waiting for a client tool result" : "waiting for muse output"
      this.fail(new Error(`muse bridge: timed out ${what} after ${timeout}ms`))
      if (!this.attached) this.finalize()
      else this.kill()
    }, timeout)
    this.timer.unref?.()
  }

  touch() {
    this.#arm()
  }

  kill() {
    const child = this.child
    if (!child || this.exited) return
    try { child.kill("SIGTERM") } catch {}
    const timer = setTimeout(() => {
      if (!this.exited) try { child.kill("SIGKILL") } catch {}
    }, 3_000)
    timer.unref?.()
  }

  push(event) {
    if (this.finalized) return
    this.firstResolve?.()
    this.firstResolve = null
    const waiter = this.waiters.shift()
    if (waiter) waiter.resolve(event)
    else this.events.push(event)
  }

  next() {
    if (this.events.length) return Promise.resolve(this.events.shift())
    if (this.finalized) return Promise.reject(new Error("muse bridge: response is closed"))
    return new Promise((resolve, reject) => this.waiters.push({ resolve, reject }))
  }

  // The next event if one comes within ms, else null.
  nextWithin(ms) {
    if (this.events.length) return Promise.resolve(this.events.shift())
    if (this.finalized || this.done) return Promise.resolve(null)
    return new Promise((resolve, reject) => {
      const waiter = {
        resolve: (event) => { clearTimeout(timer); resolve(event) },
        reject: (error) => { clearTimeout(timer); reject(error) },
      }
      const timer = setTimeout(() => {
        const index = this.waiters.indexOf(waiter)
        if (index >= 0) this.waiters.splice(index, 1)
        resolve(null)
      }, ms)
      this.waiters.push(waiter)
    })
  }

  unshift(event) {
    this.events.unshift(event)
  }

  attach() {
    if (this.finalized) throw new BusyError("muse bridge: this response has already completed")
    if (this.attached) throw new BusyError("muse bridge: this conversation already has an active response")
    this.attached = true
  }

  detach() {
    this.attached = false
  }

  acceptMcpCall(message, socket) {
    if (this.done || this.finalized) throw new Error("muse bridge: no active turn for MCP call")
    const name = message.name
    if (!this.tools.some((tool) => tool.name === name)) throw new Error(`muse bridge: undeclared tool ${name}`)
    const call = {
      id: "toolu_" + randomUUID().replace(/-/g, "").slice(0, 24),
      name,
      arguments: message.arguments ?? {},
      upstreamId: message.meta?.callId ?? null,
      socket,
      responded: false,
      result: null,
    }
    this.calls.push(call)
    toolCalls.set(call.id, { conv: this.conv, turn: this, call })
    this.#arm()
    this.push({ type: "tool", call })
    socket.once("close", () => {
      if (!call.responded && !this.finalized) {
        this.fail(new Error(`muse bridge: MCP helper disconnected during ${name}`))
        this.kill()
      }
    })
    return call
  }

  validateResults(results) {
    const unique = new Map()
    for (const item of results) {
      const id = item.block.tool_use_id
      const serialized = JSON.stringify(item.result)
      const previous = unique.get(id)
      if ((previous && JSON.stringify(previous.result) !== serialized) ||
        (item.call.result && JSON.stringify(item.call.result) !== serialized)) {
        const error = new Error(`muse bridge: conflicting duplicate result for ${id}`)
        error.statusCode = 409
        throw error
      }
      if (!previous) unique.set(id, item)
    }
    return unique
  }

  continueWith(results) {
    if (this.finalized) throw new BusyError("muse bridge: no response is waiting for these tool results")
    for (const { call, result } of this.validateResults(results).values()) {
      if (call.responded || this.done) continue
      call.result = result
      respondMcp(call, { result })
    }
    this.#arm()
    this.conv.lastUsed = Date.now()
  }

  finalize() {
    if (this.finalized) return
    this.finalized = true
    this.detach()
    for (const waiter of this.waiters.splice(0)) waiter.reject(new Error("muse bridge: response closed"))
    for (const call of this.calls) {
      if (toolCalls.get(call.id)?.call === call) toolCalls.delete(call.id)
      if (!call.responded) respondMcp(call, { error: { code: -32603, message: "muse bridge: response closed before the tool result arrived" } })
    }
    if (this.conv.turn === this) this.conv.turn = null
    if (!this.exited) {
      // A turn cut short leaves a partial turn in muse's session log; the
      // next request replays history into a new session instead.
      if (this.conv.sessionId === this.sessionId) this.conv.reset()
      this.kill()
    }
    this.conv.lastUsed = Date.now()
  }
}

class SdkTurn extends Turn {
  start() {
    liveTurns.add(this)
    this.touch()
    this.startSdk().catch((error) => this.sdkFailed(error))
  }

  async startSdk() {
    await this.conv.runtimeClosing
    if (this.finalized || this.done) return
    const conv = this.conv
    // MSP's session MCP schema omits tool_timeout_sec. This conversation owns
    // its entire host, so use native host settings to retain long client waits.
    // Do not also inject the same server in session/start: that is a name conflict.
    if (!this.conv.runtime) writeSettings(this.conv, this.tools.length > 0)
    this.runtime = this.conv.runtime ??= new MuseSdkRuntime({
      command: this.musePath,
      model: this.model,
      cwd: this.conv.dirs.work,
      env: { ...museEnv(this.conv.dirs), MUSE_CONTRIBUTOR_MODE: "0" },
      baseURL: process.env.MUSE_BRIDGE_BASE_URL,
      onStderr: (chunk) => {
        const current = conv.turn
        if (current) current.stderrTail = (current.stderrTail + chunk).slice(-STDERR_TAIL)
      },
      onExit: () => syncAuth(conv.dirs.config),
      onWarning: (message) => console.warn(`muse bridge: ${message}`),
    })
    sdkRuntimes.add(this.runtime)
    await this.runtime.start({
      model: this.model, effort: this.effort,
      prompt: this.prompt, images: this.images,
      replayInput: () => {
        const images = []
        return { prompt: renderInitialPrompt(this.body, this.conv.workDir, this.tools, images), images }
      },
      onSession: (sessionId) => { this.sessionId = sessionId; this.conv.sessionId = sessionId },
      onActivity: () => this.touch(),
      onText: (text) => { this.sawText = true; this.push({ type: "text", text }) },
      onComplete: (usage) => {
        if (this.finalized || this.done) return
        syncAuth(this.conv.dirs.config)
        this.done = true
        this.exited = true
        this.usage = usage
        clearTimeout(this.timer)
        liveTurns.delete(this)
        this.push({ type: "result", text: "", usage })
      },
      onError: (error) => this.sdkFailed(error),
    })
  }

  sdkFailed(error) {
    if (this.finalized || this.done) return
    syncAuth(this.conv.dirs.config)
    const tail = this.stderrTail.trim()
    if (tail && !error.message.includes(tail)) error.message += `\n${tail}`
    this.fail(error)
    this.kill()
    if (!this.attached) this.finalize()
  }

  kill() {
    clearTimeout(this.timer)
    liveTurns.delete(this)
    this.exited = true
    if (this.runtime && this.conv.runtime === this.runtime) this.conv.reset()
    else this.runtime?.close()
  }
}

function respondMcp(call, payload) {
  if (call.responded) return
  call.responded = true
  if (call.socket?.writable) call.socket.end(JSON.stringify(payload) + "\n")
  else call.socket?.destroy()
}

function writeSettings(conv, withTools) {
  const settings = { schema_version: 1 }
  if (withTools) {
    settings.mcpServers = {
      [MCP_SERVER_NAME]: {
        type: "stdio",
        command: process.execPath,
        args: [MCP_SERVER_PATH],
        env: {
          MUSE_BRIDGE_CONTROL_PORT: String(controlServer.address().port),
          MUSE_BRIDGE_TOKEN: conv.token,
        },
        mode: "required",
        tool_timeout_sec: Math.ceil(TOOL_RESULT_TIMEOUT_MS / 1000) + 60,
      },
    }
  }
  const file = path.join(conv.dirs.config, "muse", "settings.json")
  const tmp = `${file}.${randomUUID()}`
  fs.writeFileSync(tmp, JSON.stringify(settings, null, 2), { mode: 0o600 })
  fs.renameSync(tmp, file)
}

function evictIdle() {
  const cutoff = Date.now() - IDLE_MS
  for (const conv of [...pool.values()]) {
    if (!conv.turn && conv.lastUsed < cutoff) conv.dispose()
  }
  while (pool.size > MAX_CONVS) {
    let oldest = null
    for (const conv of pool.values()) {
      if (conv.turn) continue
      if (!oldest || conv.lastUsed < oldest.lastUsed) oldest = conv
    }
    if (!oldest) break
    oldest.dispose()
  }
}

setInterval(evictIdle, 60_000).unref()

const acquireLocks = new Map()

async function withAcquireLock(key, fn) {
  const previous = acquireLocks.get(key) || Promise.resolve()
  let release
  const current = new Promise((resolve) => { release = resolve })
  acquireLocks.set(key, current)
  await previous
  try {
    return await fn()
  } finally {
    release()
    if (acquireLocks.get(key) === current) acquireLocks.delete(key)
  }
}

function stableJSON(value) {
  return JSON.stringify(value, (_key, item) => item && typeof item === "object" && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]]))
    : item)
}

// Compare conversation content, not transport metadata or client-assigned IDs.
// Keep argument values, result contents and internal whitespace significant.
function historyKey(messages) {
  const rows = []
  const ids = new Map()
  for (const message of messages) {
    const blocks = Array.isArray(message.content) ? message.content : [{ type: "text", text: message.content ?? "" }]
    for (const block of blocks) {
      if (block.type === "thinking" || block.type === "redacted_thinking") continue
      let value
      if (typeof block === "string" || block.type === "text") {
        value = { type: "text", text: typeof block === "string" ? block : block.text || "" }
      } else if (block.type === "tool_use") {
        const ordinal = ids.size + 1
        ids.set(block.id, ordinal)
        value = { type: "tool_use", id: ordinal, name: block.name, input: block.input ?? {} }
      } else if (block.type === "tool_result") {
        value = { type: "tool_result", id: ids.get(block.tool_use_id) ?? block.tool_use_id, ...toolResult(block) }
      } else {
        value = block
      }
      let row = rows.at(-1)
      if (!row || row.role !== message.role) {
        row = { role: message.role, content: [] }
        rows.push(row)
      }
      const last = row.content.at(-1)
      if (last?.type === "text" && value.type === "text") last.text += value.text
      else row.content.push(value)
    }
  }
  for (const row of rows) {
    row.content = row.content.filter(block => block.type !== "text" || (block.text = block.text.trim()) !== "")
  }
  return stableJSON(rows.filter(row => row.content.length))
}

function trailingMessages(body) {
  let start = body.messages.length
  while (start > 0 && body.messages[start - 1].role !== "assistant") start--
  return { history: body.messages.slice(0, start), messages: body.messages.slice(start) }
}

function lastAssistantCalls(messages) {
  let start = messages.length
  while (start > 0 && messages[start - 1].role === "assistant") start--
  return messages.slice(start).flatMap(message => Array.isArray(message.content)
    ? message.content.filter(block => block.type === "tool_use") : [])
}

function matchToolResults(body, model, blocks) {
  const direct = blocks.map(block => ({ block, match: toolCalls.get(block.tool_use_id) }))
  if (direct.some(item => item.match)) return direct
  const { history } = trailingMessages(body)
  const calls = lastAssistantCalls(history)
  const byID = new Map(calls.map((call, index) => [call.id, index]))
  if (!calls.length || byID.size !== calls.length || calls.some(call => !call.id) ||
    blocks.some(block => !byID.has(block.tool_use_id))) return direct
  let found = null
  for (const conv of pool.values()) {
    const turn = conv.turn
    if (!turn || turn.finalized || conv.model !== model || !conv.matchesHistory(history)) continue
    const shown = lastAssistantCalls(conv.expected)
    if (shown.length !== calls.length || shown.some((call, index) =>
      call.name !== calls[index].name || stableJSON(call.input ?? {}) !== stableJSON(calls[index].input ?? {}))) continue
    const mapped = blocks.map(block => ({ block, match: toolCalls.get(shown[byID.get(block.tool_use_id)].id) }))
    if (mapped.some(item => !item.match) || !mapped.some(item => !item.match.call.responded)) continue
    if (found) throw new BusyError("muse bridge: renamed tool IDs match more than one pending conversation")
    found = mapped
  }
  return found || direct
}

function conversationKey(body, _model) {
  const system = historyKey([{ role: "system", content: body.system || "" }])
  const first = body.messages?.[0]
  const firstText = first ? historyKey([first]) : ""
  const discriminator = body.metadata?.user_id || ""
  // Model selection is mutable session state in MSP; do not fork the bridge
  // conversation merely because the caller picked another Muse model.
  const source = (TRANSPORT === "sdk" ? "" : _model + "\n") + discriminator + "\n" + system + "\n===\n" + firstText
  return createHash("sha256").update(source).digest("hex")
}

function normalizeTools(body) {
  if (!Array.isArray(body.tools) || !body.tools.length) return []
  const choice = body.tool_choice
  if (choice === "none" || choice?.type === "none") return []
  const selected = choice?.type === "tool" ? choice.name : null
  const seen = new Set()
  const tools = []
  for (const tool of body.tools) {
    if (!tool || typeof tool.name !== "string" || !tool.name) {
      throw new UnsupportedContent("a tool without a valid name")
    }
    if (seen.has(tool.name)) throw new UnsupportedContent(`duplicate tool ${tool.name}`)
    seen.add(tool.name)
    if (selected && tool.name !== selected) continue
    const inputSchema = tool.input_schema ?? { type: "object", properties: {} }
    if (!inputSchema || typeof inputSchema !== "object" || Array.isArray(inputSchema)) {
      throw new UnsupportedContent(`an invalid schema for tool ${tool.name}`)
    }
    tools.push({
      name: tool.name,
      description: typeof tool.description === "string" ? tool.description : "",
      inputSchema,
    })
  }
  if (selected && !tools.length) throw new UnsupportedContent(`tool_choice names undeclared tool ${selected}`)
  return tools
}

const IMAGE_EXT = { "image/png": "png", "image/jpeg": "jpg", "image/jpg": "jpg", "image/gif": "gif", "image/webp": "webp" }
const IMAGE_MEDIA = { png: "image/png", jpg: "image/jpeg", gif: "image/gif", webp: "image/webp" }

// blockText renders a user block as prompt text. Images in the current turn
// go to sink (and on to `muse exec --image`); older ones become a marker.
function blockText(block, sink) {
  if (typeof block === "string") return block
  if (!block || typeof block !== "object" || Array.isArray(block)) {
    throw new UnsupportedContent("a non-object content block")
  }
  if (block.type === "text") return typeof block.text === "string" ? block.text : ""
  if (block.type === "tool_result") {
    const inner = Array.isArray(block.content)
      ? block.content.map((part) => part?.type === "image" ? "[image returned by tool]" : blockText(part)).join("")
      : String(block.content ?? "")
    return `[tool result${block.tool_use_id ? " id=" + block.tool_use_id : ""}${block.is_error ? " error" : ""}]\n${inner}\n[end of tool result]`
  }
  if (block.type === "image") {
    const ext = IMAGE_EXT[String(block.source?.media_type || "").toLowerCase()]
    if (block.source?.type !== "base64" || !block.source.data || !ext) {
      throw new UnsupportedContent("an image that is not base64 PNG/JPEG/GIF/WebP")
    }
    if (!sink) return "[image attached earlier in the conversation]"
    sink.push({ data: block.source.data, ext, mediaType: IMAGE_MEDIA[ext] })
    return `[image ${sink.length} attached]`
  }
  if (block.type === "document") throw new UnsupportedContent("a document block")
  if (block.type === "tool_use") throw new UnsupportedContent("a tool_use block in a user message")
  throw new UnsupportedContent(`a content block of type ${JSON.stringify(block.type)}`)
}

function messageText(message, sink) {
  if (typeof message.content === "string") return message.content
  if (Array.isArray(message.content)) return message.content.map((block) => blockText(block, sink)).join("")
  return String(message.content ?? "")
}

function renderAssistantTurn(message) {
  const parts = []
  const blocks = Array.isArray(message.content)
    ? message.content
    : [{ type: "text", text: String(message.content ?? "") }]
  for (const block of blocks) {
    if (block.type === "text") parts.push(block.text || "")
    else if (block.type === "tool_use") {
      parts.push(`[tool call ${block.name} id=${block.id || ""} args=${JSON.stringify(block.input ?? {})}]`)
    }
  }
  return parts.join("\n")
}

function systemText(body) {
  if (!body.system) return ""
  return typeof body.system === "string" ? body.system : body.system.map((block) => block.text || "").join("")
}

// Claude Code sends system-role entries inside `messages` (often last). They
// are instructions, not turns: fold well-formed ones into `system` so the last
// remaining message is the user's. Malformed ones stay for validateBody.
function foldSystemMessages(body) {
  if (!Array.isArray(body?.messages)) return
  const texts = []
  const kept = []
  for (const message of body.messages) {
    if (message?.role === "system" || message?.role === "developer") {
      const c = message.content
      if (typeof c === "string") { texts.push(c); continue }
      if (Array.isArray(c) && c.every(block => block?.type === "text" && typeof block.text === "string")) {
        texts.push(c.map(block => block.text).join("")); continue
      }
    }
    kept.push(message)
  }
  if (!texts.length) return
  body.messages = kept
  const extra = texts.join("\n\n")
  if (!body.system) body.system = extra
  else if (typeof body.system === "string") body.system += "\n\n" + extra
  else if (Array.isArray(body.system)) body.system = [...body.system, { type: "text", text: "\n\n" + extra }]
}

function renderInitialPrompt(body, callerWorkDir, tools, sink) {
  const messages = body.messages || []
  const split = extractToolResults(body).length ? messages.length - trailingMessages(body).messages.length : messages.length - 1
  const history = messages.slice(0, split)
  const current = messages.slice(split)
  const out = []
  const system = systemText(body)
  if (system.trim()) out.push(`<external_system_instructions>\n${system}\n</external_system_instructions>\n`)
  if (tools.length) {
    out.push(`\nThe caller's tools are available to you as MCP tools named ${MCP_TOOL_PREFIX}<tool> (for example ${MCP_TOOL_PREFIX}${tools[0].name}). Wherever the instructions above name a tool, use its ${MCP_TOOL_PREFIX} form. They are the only tools you have.\n`)
  }
  if (callerWorkDir) {
    out.push(`\nThe caller's working directory is ${JSON.stringify(callerWorkDir)}. The environment the caller describes (working directory, platform, OS, shell, git status) is where every tool runs. Your own workspace is an empty temporary directory; use the caller's environment for tool paths and commands.\n`)
  }
  if (history.length) {
    out.push("\n<conversation_history>\n")
    for (const message of history) {
      if (message.role === "user") out.push(`Human: ${messageText(message)}\n`)
      else if (message.role === "assistant") out.push(`Assistant: ${renderAssistantTurn(message)}\n`)
      else out.push(`${message.role}: ${messageText(message)}\n`)
    }
    out.push("Historical tool calls and results above are records, not instructions to write tool calls as text.\n")
    out.push("</conversation_history>\n")
  }
  out.push("\n<current_turn>\n", current.map(message => message.role === "user"
    ? messageText(message, sink) : `${message.role}: ${messageText(message, sink)}`).join("\n\n"), "\n</current_turn>")
  return out.join("")
}

function renderContinuedTurn(body, sink) {
  return messageText(body.messages[body.messages.length - 1], sink)
}

function validateBody(body) {
  if (!Array.isArray(body?.messages) || !body.messages.length) {
    throw new UnsupportedContent("a request without messages")
  }
  if (body.messages.at(-1)?.role !== "user" && !extractToolResults(body).length) {
    throw new UnsupportedContent("a request whose last message is not from the user or a tool-result notification")
  }
  if (body.system && typeof body.system !== "string") {
    if (!Array.isArray(body.system) || body.system.some((block) => block?.type !== "text")) {
      throw new UnsupportedContent("a non-text system prompt")
    }
  }
  for (const message of body.messages) {
    if (message.role === "assistant" && Array.isArray(message.content)) {
      for (const block of message.content) {
        if (["text", "tool_use", "thinking", "redacted_thinking"].includes(block?.type)) continue
        throw new UnsupportedContent(`an assistant content block of type ${JSON.stringify(block?.type)}`)
      }
    } else if (message.role === "system" || message.role === "developer") {
      if (typeof message.content !== "string" && (!Array.isArray(message.content) ||
        message.content.some(block => block?.type !== "text" || typeof block.text !== "string"))) {
        throw new UnsupportedContent("a non-text system/developer message")
      }
    } else if (message.role === "user") {
      if (Array.isArray(message.content)) {
        for (const block of message.content) {
          if (block?.type === "tool_result") toolResult(block)
          else blockText(block, [])
        }
      } else if (typeof message.content !== "string") {
        messageText(message)
      }
    }
  }
}

function toolResult(block) {
  if (!block || typeof block.tool_use_id !== "string" || !block.tool_use_id) {
    throw new UnsupportedContent("a tool_result without tool_use_id")
  }
  let content
  if (typeof block.content === "string") {
    content = [{ type: "text", text: block.content }]
  } else if (Array.isArray(block.content)) {
    content = block.content.map((part) => {
      if (part?.type === "text" && typeof part.text === "string") return { type: "text", text: part.text }
      if (part?.type === "image" && part.source?.type === "base64" && part.source.data) {
        return { type: "image", data: part.source.data, mimeType: part.source.media_type || "application/octet-stream" }
      }
      throw new UnsupportedContent("this tool_result content")
    })
  } else if (block.content == null) {
    content = [{ type: "text", text: "" }]
  } else {
    throw new UnsupportedContent("non-text tool_result content")
  }
  return { content, isError: block.is_error === true }
}

function extractToolResults(body) {
  return trailingMessages(body).messages.flatMap(message => message.role === "user" && Array.isArray(message.content)
    ? message.content.filter(block => block?.type === "tool_result") : [])
}

// Forward complete protocol-generated context notices without turning ordinary
// user instructions into tool output. OpenCode can append a <system-update>
// after a tool result when its dynamic tool catalog changes, and omp appends
// <advisory> blocks from its advisor.
function withContextNotices(results, body) {
  const notices = []
  let seenResult = false
  // The advisor in omp prepends a fixed one-line preamble to its first
  // <advisory> block; consume it together with the block. A user message such
  // as "The user sent a new message while you were working:" is not matched,
  // so it is still rejected below.
  const contextNotice = /<system-update(?:\s[^>]*)?>[\s\S]*?<\/system-update>|(?:The following is an aggregated review from other models\.[^<]*)?<advisory(?:\s[^>]*)?>[\s\S]*?<\/advisory>|(?:\[SYSTEM NOTIFICATION - NOT USER INPUT\][^<]*)?<task-notification>[\s\S]*?<\/task-notification>/g
  for (const message of trailingMessages(body).messages) {
    const blocks = Array.isArray(message.content) ? message.content : [message.content]
    for (const block of blocks) {
      if (block?.type === "tool_result") {
        seenResult = true
        continue
      }
      const text = blockText(block)
      if (!seenResult && text.trim()) {
        throw new UnsupportedContent("text beside a live tool_result; send it after the tool response completes")
      }
      notices.push(...Array.from(text.matchAll(contextNotice), match => match[0]))
      const rest = text.replace(contextNotice, "").replace(/<\/?system-reminder(?:\s[^>]*)?>/g, "").trim()
      if (/The user sent (?:a new message while you were working|the following message):/.test(rest) ||
        (rest && !/^(?:<total_tokens>[^<]*<\/total_tokens>|Token usage: \S+; \S+ remaining)$/.test(rest) &&
        !/^[A-Z][A-Za-z]+(?::\S+)? hook (?:additional context|success|blocking error(?: from command)?|stopped continuation|feedback):/.test(rest))) {
        throw new UnsupportedContent("text beside a live tool_result; send it after the tool response completes")
      }
    }
  }
  if (!notices.length) return results
  const last = results.at(-1)
  return [...results.slice(0, -1), { ...last, result: {
    ...last.result,
    content: [...last.result.content, { type: "text", text: `<system-reminder>\n${notices.join("\n\n")}\n</system-reminder>` }],
  } }]
}

function namedWorkDirectory(body, init) {
  const raw = new Headers(init.headers || {}).get("x-magpie-work-dir")
  if (raw) {
    try { return decodeURIComponent(raw) } catch { return raw }
  }
  const texts = []
  for (const message of [{ role: "system", content: body.system }, ...body.messages]) {
    if (message.role === "assistant") continue
    if (typeof message.content === "string") texts.push(message.content)
    else if (Array.isArray(message.content)) {
      for (const block of message.content) if (block?.type === "text") texts.push(block.text || "")
    }
  }
  let directory = null
  const pattern = /(?:Primary working directory|^\s*(?:-\s*)?Working directory|Current working directory): *([^\r\n]+)$|<cwd>([^<\r\n]+)<\/cwd>/gm
  for (const text of texts) {
    for (const match of text.matchAll(pattern)) {
      const value = (match[1] || match[2]).trim().replace(/^[`'"]+|[`'"]+$/g, "")
      if (value) directory = value
    }
  }
  return directory
}

function ensureControlServer() {
  if (controlServerPromise) return controlServerPromise
  controlServerPromise = new Promise((resolve, reject) => {
    const server = net.createServer((socket) => handleControlConnection(socket))
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      controlServer = server
      server.unref()
      resolve(server.address().port)
    })
  })
  return controlServerPromise
}

function tokenMatches(left, right) {
  if (typeof left !== "string" || typeof right !== "string") return false
  const a = createHash("sha256").update(left).digest()
  const b = createHash("sha256").update(right).digest()
  return timingSafeEqual(a, b)
}

function handleControlConnection(socket) {
  socket.setEncoding("utf8")
  let buffer = ""
  let handled = false
  socket.on("data", (data) => {
    if (handled) return
    buffer += data
    if (buffer.length > CONTROL_LINE_LIMIT) {
      socket.destroy()
      return
    }
    const newline = buffer.indexOf("\n")
    if (newline < 0) return
    handled = true
    let message
    try { message = JSON.parse(buffer.slice(0, newline)) } catch {
      socket.end(JSON.stringify({ error: { code: -32700, message: "invalid control JSON" } }) + "\n")
      return
    }
    const conv = sessions.get(message.token)
    if (!conv || !tokenMatches(message.token, conv.token)) {
      socket.end(JSON.stringify({ error: { code: -32603, message: "invalid or expired bridge session" } }) + "\n")
      return
    }
    try {
      const turn = conv.turn
      if (message.kind === "list") {
        socket.end(JSON.stringify({ result: { tools: turn && !turn.finalized ? turn.tools : [] } }) + "\n")
        return
      }
      if (message.kind === "call") {
        if (!turn) throw new Error("muse bridge: no active turn for MCP call")
        turn.acceptMcpCall(message, socket)
        return
      }
      socket.end(JSON.stringify({ error: { code: -32601, message: "unknown control request" } }) + "\n")
    } catch (error) {
      socket.end(JSON.stringify({ error: { code: -32603, message: String(error?.message ?? error) } }) + "\n")
    }
  })
  socket.on("error", () => {})
}

function sseEvent(event, data) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
}

// Muse reports OpenAI-style usage (input includes cached); Anthropic's
// input_tokens excludes cache reads.
function translateUsage(usage) {
  let input = 0
  let cached = 0
  let written = 0
  let output = 0
  let reasoning = 0
  for (const row of usage?.models ?? []) {
    input += Number(row.input_tokens) || 0
    cached += Number(row.cached_tokens) || 0
    written += Number(row.cache_write_tokens) || 0
    output += Number(row.output_tokens) || 0
    reasoning += Number(row.reasoning_tokens) || 0
  }
  return {
    input_tokens: Math.max(0, input - cached - written),
    output_tokens: output,
    cache_read_input_tokens: cached,
    ...(written > 0 ? { cache_creation_input_tokens: written } : {}),
    ...(reasoning > 0 ? { output_tokens_details: { thinking_tokens: reasoning } } : {}),
  }
}

function makeAnthropicStream(conv, turn, body, msgId, signal) {
  const encoder = new TextEncoder()
  const responseContent = []
  let responseText = ""
  let blockIndex = 0
  let textBlockOpen = false
  let pingTimer = null
  let finished = false
  let abortHandler = null

  return new ReadableStream({
    async start(controller) {
      const send = (event, data) => controller.enqueue(encoder.encode(sseEvent(event, data)))
      const closeTextBlock = () => {
        if (!textBlockOpen) return
        responseContent.push({ type: "text", text: responseText })
        responseText = ""
        send("content_block_stop", { type: "content_block_stop", index: blockIndex })
        blockIndex++
        textBlockOpen = false
      }
      const emitText = (text) => {
        if (!text) return
        if (!textBlockOpen) {
          send("content_block_start", { type: "content_block_start", index: blockIndex, content_block: { type: "text", text: "" } })
          textBlockOpen = true
        }
        responseText += text
        send("content_block_delta", { type: "content_block_delta", index: blockIndex, delta: { type: "text_delta", text } })
      }
      const emitToolUse = (call) => {
        closeTextBlock()
        send("content_block_start", {
          type: "content_block_start",
          index: blockIndex,
          content_block: { type: "tool_use", id: call.id, name: call.name, input: {} },
        })
        send("content_block_delta", {
          type: "content_block_delta",
          index: blockIndex,
          delta: { type: "input_json_delta", partial_json: JSON.stringify(call.arguments) },
        })
        send("content_block_stop", { type: "content_block_stop", index: blockIndex })
        blockIndex++
        responseContent.push({ type: "tool_use", id: call.id, name: call.name, input: call.arguments })
      }
      const detach = () => {
        finished = true
        turn.detach()
        if (pingTimer) clearInterval(pingTimer)
        pingTimer = null
        if (signal && abortHandler) signal.removeEventListener("abort", abortHandler)
        abortHandler = null
      }
      const stopMessage = (stopReason, usage) => {
        send("message_delta", { type: "message_delta", delta: { stop_reason: stopReason, stop_sequence: null }, usage })
        send("message_stop", { type: "message_stop" })
      }
      const fatal = (error) => {
        if (finished) return
        try {
          closeTextBlock()
          const { status, message } = classifyError(error)
          send("error", { type: "error", error: { type: errorType(status), message } })
          turn.finalize()
          detach()
          controller.close()
        } catch {
          turn.finalize()
          detach()
          try { controller.error(error) } catch {}
        }
      }
      const abort = () => {
        if (finished) return
        detach()
        turn.finalize()
        try { controller.error(signal?.reason || new Error("request aborted")) } catch {}
      }
      abortHandler = abort
      signal?.addEventListener("abort", abort, { once: true })
      if (signal?.aborted) {
        abort()
        return
      }

      const emptyUsage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0 }
      try {
        send("message_start", {
          type: "message_start",
          message: {
            id: msgId,
            type: "message",
            role: "assistant",
            model: body.model,
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 0, output_tokens: 0 },
          },
        })
        pingTimer = setInterval(() => {
          try { send("ping", { type: "ping" }) } catch {}
        }, PING_INTERVAL_MS)

        for (;;) {
          const event = await turn.next()
          if (finished) return
          if (event.type === "text") {
            emitText(event.text)
            continue
          }
          if (event.type === "tool") {
            emitToolUse(event.call)
            // Muse may run a model step's calls concurrently: hand over every
            // call that arrives together in one assistant message.
            for (;;) {
              const more = await turn.nextWithin(TOOL_BATCH_MS)
              if (!more) break
              if (more.type !== "tool") {
                turn.unshift(more)
                break
              }
              emitToolUse(more.call)
            }
            if (finished) return
            stopMessage("tool_use", emptyUsage)
            conv.recordAssistant(turn, responseContent)
            detach()
            controller.close()
            return
          }
          if (event.type === "result") {
            emitText(event.text)
            closeTextBlock()
            stopMessage("end_turn", event.usage ? translateUsage(event.usage) : emptyUsage)
            conv.recordAssistant(turn, responseContent)
            turn.finalize()
            detach()
            controller.close()
            return
          }
          if (event.type === "error") {
            fatal(event.error)
            return
          }
        }
      } catch (error) {
        fatal(error)
      }
    },
    cancel() {
      if (finished) return
      finished = true
      turn.detach()
      if (pingTimer) clearInterval(pingTimer)
      pingTimer = null
      if (signal && abortHandler) signal.removeEventListener("abort", abortHandler)
      abortHandler = null
      turn.finalize()
    },
  })
}

const AUTH_FAILURE = /not logged in|run `?muse login`?|log in again|sign in again|was rejected|unauthori[sz]ed|no login to refresh/i
const QUOTA_FAILURE = /quota|rate limit|usage limit|allowance|too many requests/i
// MSP 1.4.14's modelError has no upstream HTTP status. Match only Muse's
// specific catalog/access diagnostics; an unknown model failure remains 502.
const MODEL_ACCESS_FAILURE = /model [`"'][^`"'\r\n]+[`"'] does not exist or you lack access|Meta model [^\r\n]+ is not in this host's model catalog|model catalog has no visible models/i

function classifyError(error) {
  let message = String(error?.message ?? error)
  let status = error?.statusCode
  if ((!status || status === 404) && MODEL_ACCESS_FAILURE.test(message)) {
    status = 404
    message += "\nVerify model access with `muse exec` on this host. A successful `muse usage` check confirms sign-in, not model availability. If the official CLI also fails, refresh the Muse login and check Meta account/model access before retrying the bridge."
  }
  status ||= AUTH_FAILURE.test(message) ? 401 : QUOTA_FAILURE.test(message) ? 429 : 502
  return { status, message }
}

function errorResponse(error) {
  const { status, message } = classifyError(error)
  return jsonError(status, message, status === 401 ? { "X-Magpie-Sign-In": "expired" } : {})
}

// Hold the HTTP answer until muse says something (or a short wait passes),
// so a failure before any output, such as a lapsed sign-in, goes back as a
// status the caller can act on instead of an error inside a 200 stream.
async function respond(conv, turn, body, signal) {
  turn.attach()
  let onAbort
  const aborted = new Promise((resolve) => {
    onAbort = resolve
    signal?.addEventListener("abort", resolve, { once: true })
  })
  let gateTimer
  await Promise.race([
    turn.first,
    aborted,
    new Promise((resolve) => { gateTimer = setTimeout(resolve, FIRST_EVENT_GATE_MS) }),
  ])
  clearTimeout(gateTimer)
  signal?.removeEventListener("abort", onAbort)
  if (signal?.aborted) {
    turn.finalize()
    return jsonError(499, "request aborted")
  }
  if (turn.events[0]?.type === "error") {
    const { error } = turn.events.shift()
    turn.finalize()
    return errorResponse(error)
  }
  const msgId = "msg_" + randomUUID().replace(/-/g, "").slice(0, 24)
  return new Response(makeAnthropicStream(conv, turn, body, msgId, signal), {
    status: 200,
    headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive" },
  })
}

async function handleRequest(init) {
  if (isMuseLoginPending()) return jsonError(503, "Muse sign-in is in progress. Finish or cancel it before sending model requests.")
  if (!["sdk", "exec"].includes(TRANSPORT)) return jsonError(503, "MUSE_BRIDGE_TRANSPORT must be sdk or exec")
  const musePath = findMuse()
  if (!musePath) return jsonError(503, "muse CLI not found on this machine; install Muse Code: https://dev.meta.ai")
  let body
  try {
    const raw = typeof init.body === "string" ? init.body : new TextDecoder().decode(init.body)
    body = JSON.parse(raw)
    foldSystemMessages(body)
    validateBody(body)
  } catch (error) {
    return jsonError(error.statusCode ?? 400, error.message)
  }

  const rawModel = body.model || ""
  const requestedModel = rawModel.startsWith(`${PROVIDER_ID}/`) ? rawModel.slice(PROVIDER_ID.length + 1) : rawModel
  body = { ...body, model: requestedModel }
  const { model, effort } = resolveModel(requestedModel, body)
  const convKey = conversationKey(body, model)
  const resultBlocks = extractToolResults(body)
  const callerWorkDir = namedWorkDirectory(body, init)

  try {
    const tools = normalizeTools(body)
    if (tools.length) await ensureControlServer()

    if (resultBlocks.length) {
      const matches = matchToolResults(body, model, resultBlocks)
      const found = matches.filter((item) => item.match)
      if (found.length) {
        if (found.length !== matches.length) {
          return jsonError(409, "muse bridge: some tool results do not belong to the active response")
        }
        const { conv, turn } = found[0].match
        if (found.some((item) => item.match.conv !== conv || item.match.turn !== turn)) {
          return jsonError(409, "muse bridge: tool results from different conversations cannot be combined")
        }
        if (conv.turn !== turn) return jsonError(409, "muse bridge: the tool response has already completed")
        if (turn.attached) throw new BusyError("muse bridge: this conversation already has an active response")
        const results = withContextNotices(matches.map(({ block, match }) => ({
          block,
          call: match.call,
          result: toolResult(block),
        })), body)
        turn.validateResults(results)
        if (!conv.matchesHistory(trailingMessages(body).history) || conv.model !== model ||
          turn.toolsSignature !== stableJSON(tools) || conv.workDir !== callerWorkDir) {
          // A changed context or configuration can't go on in this muse run.
          // Replay the real results into a new session instead.
          turn.finalize()
          conv.reset()
        } else {
          if (!turn.done) {
            turn.continueWith(results)
            conv.recordToolResults(turn, body.messages)
          }
          return await respond(conv, turn, body, init.signal)
        }
      } else if (pool.get(convKey)?.turn) {
        return jsonError(409, "muse bridge: no active MCP call matches these tool results")
      }
    }

    return await withAcquireLock(convKey, async () => {
      evictIdle()
      let conv = pool.get(convKey)
      if (conv?.turn) throw new BusyError("muse bridge: this conversation still has an unfinished response")
      if (liveTurns.size >= MAX_ACTIVE) {
        throw new BusyError(`muse bridge: ${MAX_ACTIVE} muse runs are in flight; try again shortly`)
      }
      if (!conv) {
        conv = new Conv(convKey)
        pool.set(convKey, conv)
      }
      const history = body.messages.slice(0, -1)
      const sameWorkDir = conv.workDir === callerWorkDir
      const sameTools = TRANSPORT !== "sdk" || conv.toolsSignature === stableJSON(tools)
      const sameHistory = history.length > 0 && conv.matchesHistory(history)
      const resume = conv.sessionId && (TRANSPORT === "sdk" || conv.model === model) && sameWorkDir && sameTools && !resultBlocks.length && sameHistory
      if (!resume) conv.reset()
      conv.model = model
      conv.workDir = callerWorkDir
      conv.toolsSignature = stableJSON(tools)
      const images = []
      const prompt = resume ? renderContinuedTurn(body, images) : renderInitialPrompt(body, callerWorkDir, tools, images)
      const turn = conv.startTurn({ musePath, prompt, images, tools, model, effort, body, messages: body.messages })
      return await respond(conv, turn, body, init.signal)
    })
  } catch (error) {
    return errorResponse(error)
  }
}

async function checkSignIn(musePath, { browserOnly = false, json = false } = {}) {
  const dirs = makeDirs(path.join(ensureBridgeRoot(), "probe-" + randomUUID()))
  try {
    fs.writeFileSync(path.join(dirs.config, "muse", "settings.json"), JSON.stringify({ schema_version: 1 }), { mode: 0o600 })
    const env = museEnv(dirs)
    if (browserOnly) delete env.META_API_KEY
    const probe = await execOnce(musePath, json ? ["usage", "--json"] : ["usage"], { cwd: dirs.work, env, timeoutMs: 30_000 })
    syncAuth(dirs.config)
    return probe
  } finally {
    fs.promises.rm(dirs.base, { recursive: true, force: true }).catch(() => {})
  }
}

function modelEntry(model) {
  return {
    id: model.id,
    name: model.name,
    family: "muse",
    api: { id: model.id, url: "muse://local", npm: NPM_ANTHROPIC },
    status: "active",
    headers: {},
    options: {},
    cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
    limit: { context: model.context, output: model.output },
    capabilities: {
      temperature: false,
      reasoning: true,
      attachment: true,
      toolcall: true,
      input: { text: true, image: true, audio: false, video: false, pdf: false },
      output: { text: true, image: false, audio: false, video: false, pdf: false },
    },
    variants: Object.fromEntries(model.efforts.map((effort) => [effort, {}])),
  }
}

export const MuseBridgePlugin = async () => {
  const auth = createMuseAuth({
    findMuse, checkSignIn,
    beforeLogin: async () => {
      if (liveTurns.size) throw new Error("Finish or cancel active Muse requests before changing the Muse account.")
      const previous = [...pool.values()]
      for (const conv of previous) conv.dispose()
      await Promise.all(previous.map((conv) => conv.runtimeClosing))
    },
    createLoginContext: () => {
      // Isolate model/provider settings from Magpie's own endpoint rewrite, but
      // let the official CLI load and save the user's sign-in through auth.json.
      const dirs = makeDirs(path.join(ensureBridgeRoot(), "login-" + randomUUID()))
      fs.writeFileSync(path.join(dirs.config, "muse/settings.json"), JSON.stringify({ schema_version: 1 }), { mode: 0o600 })
      return { cwd: dirs.work, env: museEnv(dirs), cleanup: async () => {
        syncAuth(dirs.config)
        await fs.promises.rm(dirs.base, { recursive: true, force: true })
      } }
    },
  })
  return {
    auth: {
      ...auth,
      usage: createMuseUsage({ findMuse, readUsage: (muse) => checkSignIn(muse, { json: true }), isSigningIn: isMuseLoginPending }),
      loader: async () => ({
        baseURL: "muse://local",
        apiKey: "muse",
        fetch: async (_input, init) => handleRequest(init ?? {}),
      }),
    },
    provider: {
      id: PROVIDER_ID,
      npm: NPM_ANTHROPIC,
      models: async () => Object.fromEntries(MODELS.map((model) => [model.id, modelEntry(model)])),
    },
  }
}

function errorType(status) {
  return status === 400 ? "invalid_request_error" : status === 401 ? "authentication_error" :
    status === 404 ? "not_found_error" : status === 429 ? "rate_limit_error" : "api_error"
}

function jsonError(status, message, headers = {}) {
  return new Response(
    JSON.stringify({
      type: "error",
      error: {
        type: errorType(status),
        message: String(message || "unknown error"),
      },
    }),
    { status, headers: { "Content-Type": "application/json", ...headers } },
  )
}

process.once("exit", () => {
  for (const conv of pool.values()) {
    syncAuth(conv.dirs.config)
  }
  for (const runtime of sdkRuntimes) runtime.killNow()
  for (const turn of liveTurns) {
    try { turn.child?.kill("SIGKILL") } catch {}
  }
  if (bridgeRoot) {
    try { fs.rmSync(bridgeRoot, { recursive: true, force: true }) } catch {}
  }
})

export const _test = { historyKey, conversationKey, translateUsage, resolveModel, renderInitialPrompt, syncAuth, linkAuth, evictIdle, pool, toolCalls, liveTurns }

export default { id: PROVIDER_ID, server: MuseBridgePlugin }
