#!/usr/bin/env node
import { execute } from './lib/commands.ts';
import { ClientError } from '../../packages/contracts/instance.ts';
const abort = new AbortController();
process.once('SIGINT', () => abort.abort());
process.once('SIGTERM', () => abort.abort());
try {
  const result = await execute(process.argv.slice(2), { directory: process.env.TOB_CONFIG_DIR, signal: abort.signal, prompt: value => process.stderr.write(JSON.stringify(value) + '\n') });
  console.log(JSON.stringify(result));
} catch (error) {
  const code = abort.signal.aborted ? 'CANCELLED' : error instanceof ClientError ? error.code : 'CLI_OPERATION_FAILED';
  console.log(JSON.stringify({ error: { code } })); process.exitCode = 1;
}
