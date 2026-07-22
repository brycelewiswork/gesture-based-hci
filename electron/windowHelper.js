const { spawn } = require('node:child_process')
const fs = require('node:fs')

// Wraps the long-lived Swift helper process. One command per line in, one
// result line out — resolved FIFO. Keeping the process alive is what avoids
// the ~50-150ms cost of spawning a CLI on every gesture.
class WindowHelper {
  constructor(binPath) {
    this.binPath = binPath
    this.proc = null
    this.queue = []
    this.buffer = ''
  }

  start() {
    const bin = this.binPath
    if (!fs.existsSync(bin)) {
      throw new Error(`Helper binary missing at ${bin}. Run: npm run build:helper`)
    }
    this.proc = spawn(bin, [], { stdio: ['pipe', 'pipe', 'pipe'] })
    this.proc.stdout.on('data', (d) => this._onData(d))
    this.proc.stderr.on('data', (d) => console.error('[helper:stderr]', d.toString().trim()))
    this.proc.on('exit', (code) => {
      console.error('[helper] exited with code', code)
      this.proc = null
      // Reject anything still pending so callers don't hang.
      while (this.queue.length) this.queue.shift()(`err:helper-exited:${code}`)
    })
  }

  _onData(chunk) {
    this.buffer += chunk.toString()
    let nl
    while ((nl = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, nl).trim()
      this.buffer = this.buffer.slice(nl + 1)
      const resolve = this.queue.shift()
      if (resolve) resolve(line)
    }
  }

  send(cmd) {
    return new Promise((resolve, reject) => {
      if (!this.proc) return reject(new Error('helper not running'))
      this.queue.push(resolve)
      this.proc.stdin.write(cmd + '\n')
    })
  }

  stop() {
    if (this.proc) {
      this.proc.kill()
      this.proc = null
    }
  }
}

module.exports = { WindowHelper }
