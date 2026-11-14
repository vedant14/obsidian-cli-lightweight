#!/usr/bin/env node
import { main } from '../src/cli.js';
// Pipes such as `obsl ... | head` may close stdout early.
process.stdout.on('error', error => { if (error.code === 'EPIPE') process.exit(0); else throw error; });
await main();
