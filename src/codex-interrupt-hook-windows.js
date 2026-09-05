(function () {
  function decodeHex(value) {
    if (!/^(?:[0-9a-f]{4})+$/i.test(value)) throw new Error("invalid path");
    var result = "";
    for (var index = 0; index < value.length; index += 4) {
      result += String.fromCharCode(parseInt(value.substr(index, 4), 16));
    }
    return result;
  }

  function readUtf8(path) {
    var stream = new ActiveXObject("ADODB.Stream");
    stream.Type = 2;
    stream.Charset = "utf-8";
    stream.Open();
    try {
      stream.LoadFromFile(path);
      return stream.ReadText();
    } finally {
      stream.Close();
    }
  }

  function nonnegativeInteger(value) {
    return typeof value === "number" && isFinite(value) && value >= 0 && Math.floor(value) === value;
  }

  function parseJson(text) {
    var at = 0;
    function fail() { throw new Error("invalid JSON"); }
    function whitespace() { while (/\s/.test(text.charAt(at))) at += 1; }
    function string() {
      var result = "";
      if (text.charAt(at++) !== '"') fail();
      while (at < text.length) {
        var character = text.charAt(at++);
        if (character === '"') return result;
        if (character === "\\") {
          var escape = text.charAt(at++);
          if (escape === "u") {
            var hex = text.substr(at, 4);
            if (!/^[0-9a-f]{4}$/i.test(hex)) fail();
            result += String.fromCharCode(parseInt(hex, 16));
            at += 4;
          } else {
            var escapes = { '"': '"', "\\": "\\", "/": "/", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" };
            if (typeof escapes[escape] !== "string") fail();
            result += escapes[escape];
          }
        } else {
          if (character < " ") fail();
          result += character;
        }
      }
      fail();
    }
    function value() {
      whitespace();
      var character = text.charAt(at);
      if (character === '"') return string();
      if (character === "{") {
        var object = {};
        at += 1;
        whitespace();
        if (text.charAt(at) === "}") { at += 1; return object; }
        while (at < text.length) {
          whitespace();
          if (text.charAt(at) !== '"') fail();
          var key = string();
          whitespace();
          if (text.charAt(at++) !== ":") fail();
          object[key] = value();
          whitespace();
          character = text.charAt(at++);
          if (character === "}") return object;
          if (character !== ",") fail();
        }
        fail();
      }
      if (character === "[") {
        var array = [];
        at += 1;
        whitespace();
        if (text.charAt(at) === "]") { at += 1; return array; }
        while (at < text.length) {
          array.push(value());
          whitespace();
          character = text.charAt(at++);
          if (character === "]") return array;
          if (character !== ",") fail();
        }
        fail();
      }
      var remaining = text.slice(at);
      var number = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(remaining);
      if (number) { at += number[0].length; return Number(number[0]); }
      if (remaining.indexOf("true") === 0) { at += 4; return true; }
      if (remaining.indexOf("false") === 0) { at += 5; return false; }
      if (remaining.indexOf("null") === 0) { at += 4; return null; }
      fail();
    }
    var result = value();
    whitespace();
    if (at !== text.length) fail();
    return result;
  }

  try {
    if (WScript.Arguments.length !== 1) throw new Error("invalid arguments");
    var raw = WScript.StdIn.ReadAll();
    if (unescape(encodeURIComponent(raw)).length > 32768) throw new Error("payload too large");
    var payload = parseJson(raw);
    if (typeof payload.session_id !== "string" || typeof payload.turn_id !== "string") {
      throw new Error("invalid identity");
    }
    var threadId = payload.session_id.replace(/^\s+|\s+$/g, "");
    var turnId = payload.turn_id.replace(/^\s+|\s+$/g, "");
    if (payload.hook_event_name !== "Interrupt"
        || !/^[A-Za-z0-9_-]{6,128}$/.test(threadId)
        || !/^[A-Za-z0-9_-]{6,128}$/.test(turnId)) {
      throw new Error("invalid payload");
    }

    var config = parseJson(readUtf8(decodeHex(WScript.Arguments.Item(0))).replace(/^\uFEFF/, ""));
    var port = Number(config.port);
    var token = String(config.controlToken || "");
    if (config.host !== "127.0.0.1" || !nonnegativeInteger(port) || port < 1 || port > 65535
        || !/^[A-Za-z0-9_-]{40,}$/.test(token)) {
      throw new Error("invalid endpoint");
    }

    var shell = new ActiveXObject("WScript.Shell");
    var windowsRoot = shell.ExpandEnvironmentStrings("%SystemRoot%");
    if (!/^[A-Za-z]:\\/.test(windowsRoot) || /["\r\n&|<>^%!]/.test(windowsRoot)) {
      throw new Error("invalid system root");
    }
    var curlPath = windowsRoot + "\\System32\\curl.exe";
    var request = shell.Exec('"' + curlPath + '" -q --config -');
    request.StdIn.Write([
      'url = "http://127.0.0.1:' + port + '/admin/interrupt-turn"',
      'request = "POST"',
      'header = "authorization: Bearer ' + token + '"',
      'header = "content-type: application/json"',
      'data = "{\\"threadId\\":\\"' + threadId + '\\",\\"turnId\\":\\"' + turnId + '\\"}"',
      'connect-timeout = 1',
      'max-time = 2',
      'noproxy = "*"',
      'fail',
      'silent',
      'show-error',
      ''
    ].join("\n"));
    request.StdIn.Close();
    while (request.Status === 0) WScript.Sleep(10);
    var responseText = request.StdOut.ReadAll();
    request.StdErr.ReadAll();
    if (request.ExitCode !== 0) throw new Error("request failed");
    var result = parseJson(responseText);
    if (result.status !== "ok"
        || !nonnegativeInteger(result.cancelled_http_turns)
        || !nonnegativeInteger(result.cancelled_browser_turns)) {
      throw new Error("invalid acknowledgement");
    }
  } catch (error) {
    WScript.StdErr.WriteLine("codex-chatgpt-web: Interrupt hook failed");
    WScript.Quit(1);
  }
}());
