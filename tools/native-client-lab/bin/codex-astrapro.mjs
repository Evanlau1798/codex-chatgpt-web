#!/usr/bin/env node
import { cliMain } from '../src/launch.mjs';

process.exitCode = await cliMain('codex');
