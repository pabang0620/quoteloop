import { spawn } from 'node:child_process'

// Starts the three processes: mock PayPal (:4103), supplier agent (:4102), buyer agent (:4101).
// They share nothing but HTTP.
const procs = [
  ['mock-paypal', 'mockpaypal/index.js'],
  ['supplier', 'supplier/index.js'],
  ['buyer', 'buyer/index.js'],
]
const children = procs.map(([name, file]) => {
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', file], { stdio: ['ignore', 'pipe', 'pipe'], env: process.env })
  const tag = (data) => String(data).split('\n').filter(Boolean).forEach((line) => console.log(`[${name}] ${line}`))
  child.stdout.on('data', tag)
  child.stderr.on('data', tag)
  child.on('exit', (code) => console.log(`[${name}] exited with ${code}`))
  return child
})
const stop = () => { for (const c of children) c.kill('SIGTERM'); process.exit(0) }
process.on('SIGINT', stop)
process.on('SIGTERM', stop)
