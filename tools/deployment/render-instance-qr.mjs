import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import QRCode from 'qrcode';
import { parseInstance, MOBILE_REDIRECT_URI } from '../../packages/contracts/instance.ts';

// Offline rendering only: a QR is a public configuration, never a trusted URL or credential.
try {
  const [input, output] = process.argv.slice(2);
  if (!input || !output || !output.endsWith('.svg') || resolve(input) === resolve(output)) throw Error();
  const raw = await readFile(input, 'utf8');
  if (raw.length > 4096) throw Error();
  const config = parseInstance(JSON.parse(raw));
  if (config.environment !== 'uat' || !config.auth.mobileRedirectUris.includes(MOBILE_REDIRECT_URI)) throw Error();
  const svg = await QRCode.toString(JSON.stringify(config), { type: 'svg', errorCorrectionLevel: 'M', margin: 4, width: 640 });
  await writeFile(output, svg, { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify({ rendered: true, output, server: config.server, instanceId: config.instanceId, environment: config.environment, publicConfigurationOnly: true }));
} catch {
  console.error(JSON.stringify({ error: 'QR_RENDER_FAILED', hint: 'Use a verified mobile-enabled UAT configuration and a new .svg output path.' }));
  process.exitCode = 1;
}
