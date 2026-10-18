import fs from 'node:fs';

// Recording is observational. Sink failure never cancels an in-flight response.
export function responseCapture(file, createOutput = target => fs.createWriteStream(target, { mode: 0o600, flags: 'wx' })) {
  let output, failure, ended = false, resolveDone;
  const done = new Promise(resolve => { resolveDone = resolve; });
  const fail = error => { failure ??= typeof error?.code === 'string' && /^[A-Z0-9_]{1,32}$/.test(error.code) ? error.code : 'capture_io_error'; resolveDone(); };
  try {
    output = createOutput(file);
    output.on('error', fail);
    output.once('finish', resolveDone);
    output.once('close', () => { if (!output.writableFinished && !failure) fail(); else resolveDone(); });
  } catch (error) { fail(error); }
  return {
    write(piece) { if (!failure && !ended) try { output.write(piece); } catch (error) { fail(error); } },
    async end() {
      if (!ended) { ended = true; if (!failure) try { output.end(); } catch (error) { fail(error); } }
      let timer;
      try {
        await Promise.race([done, new Promise(resolve => { timer = setTimeout(resolve, 750); })]);
        return { complete: !failure && output?.writableFinished === true,
          ...(!failure && output?.writableFinished === true ? {} : { error_code: failure || 'capture_flush_unavailable' }) };
      } finally { clearTimeout(timer); }
    },
  };
}
