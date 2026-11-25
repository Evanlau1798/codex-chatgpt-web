import fs from 'node:fs';
import { StringDecoder } from 'node:string_decoder';

export function captureChildOutput(stream, file, streamName, redactor, createOutput = target => fs.createWriteStream(target, { mode: 0o600, flags: 'wx' })) {
  if (!stream) return Promise.resolve();
  const output = createOutput(file);
  const decoder = new StringDecoder('utf8');
  let failure;
  let finished = false;
  const captured = new Promise((resolve, reject) => {
    // Recording failure must not crash the parent or cancel an otherwise live Pro turn.
    // Continue draining the child and report the capture failure after it finishes.
    output.on('error', error => { failure ??= error; stream.resume(); });
    const write = piece => { if (!failure) output.write(JSON.stringify({ at: new Date().toISOString(), stream: streamName, data: piece }) + '\n'); };
    stream.on('data', chunk => redactor.push(decoder.write(Buffer.from(chunk)), write));
    const finish = error => {
      if (finished) return;
      finished = true;
      failure ??= error;
      redactor.push(decoder.end(), write);
      redactor.end(write);
      output.end(error => { failure ??= error; failure ? reject(failure) : resolve(); });
      if (output.destroyed && failure) reject(failure);
    };
    stream.once('end', () => finish());
    stream.once('error', finish);
  });
  void captured.catch(() => {}); // The launcher awaits it after child completion.
  return captured;
}
