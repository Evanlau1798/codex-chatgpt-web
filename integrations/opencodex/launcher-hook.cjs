const fs = require('node:fs');
const path = require('node:path');
module.exports = function (invocation, args) {
  if (args.length !== 1 || args[0] !== 'serve') return invocation;
  const settings = JSON.parse(fs.readFileSync(path.join(__dirname, 'settings.json'), 'utf8'));
  if (!settings.enabled) return invocation;
  return { ...invocation, args: ['--preload', path.join(__dirname, 'preload.ts'), ...invocation.args] };
};
