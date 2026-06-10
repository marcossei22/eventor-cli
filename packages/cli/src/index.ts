import { run } from './program.js';

run(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err: unknown) => {
    // Rede de segurança: nada deveria escapar do run(), mas se escapar, não trava.
    process.stderr.write(`${JSON.stringify({ error: { code: 'fatal', message: String(err) } })}\n`);
    process.exitCode = 1;
  });
