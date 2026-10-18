#!/usr/bin/env node
import { healthCommand } from '../packages/reference/health.ts';
import { ClientError } from '../packages/contracts/instance.ts';
try { console.log(JSON.stringify(await healthCommand(['agent-health',...process.argv.slice(2)]))); }
catch(e) { console.log(JSON.stringify({error:{code:e instanceof ClientError?e.code:'HEALTH_AGENT_FAILED'}}));process.exitCode=1; }
