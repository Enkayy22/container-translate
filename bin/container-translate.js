#!/usr/bin/env node

process.env.CONTAINER_TRANSLATE_ARGV0 = 'container-translate';
const { main } = await import('../dist/src/cli.js');

try {
  await main();
} catch (err) {
  if (err && err.name === 'TranslateError') console.error(`container-translate: ${err.message}`);
  else console.error(err);
  process.exitCode = 1;
}
