import { spawn } from 'node:child_process';
import { rmSync } from 'node:fs';

const persist = '.wrangler/e2e';
rmSync(persist, { recursive: true, force: true });
const env = { ...process.env, CI: 'true', WRANGLER_SEND_METRICS: 'false' };
const run = (command, args) => new Promise((resolve, reject) => {
  const child = spawn(command, args, { stdio: 'inherit', env });
  child.on('exit', code => code === 0 ? resolve() : reject(new Error(`${command} ${args.join(' ')} exited ${code}`)));
});

await run('npm', ['run', 'build']);
await run('npx', ['wrangler', 'd1', 'migrations', 'apply', 'DB', '--local', '--persist-to', persist]);
const dev = spawn('npx', ['wrangler', 'dev', '--port', '8787', '--ip', '127.0.0.1', '--inspector-port', '9230', '--persist-to', persist], { stdio: 'inherit', env });
const stop = () => dev.kill('SIGTERM');
process.once('SIGTERM', stop);
process.once('SIGINT', stop);
dev.on('exit', code => process.exit(code ?? 0));
