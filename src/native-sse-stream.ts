const SSE_TERMINATOR = "data: [DONE]";

export function tolerateCompletedNativeSseReset(
  body: ReadableStream<Uint8Array>,
  onUncleanClose?: (bytes: number) => void,
): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let lineBuffer = "";
  let completed = false;
  let bytes = 0;

  const inspectLines = (text: string): void => {
    lineBuffer += text;
    for (let newline = lineBuffer.indexOf("\n"); newline >= 0; newline = lineBuffer.indexOf("\n")) {
      const line = lineBuffer.slice(0, newline).replace(/\r$/, "");
      lineBuffer = lineBuffer.slice(newline + 1);
      if (line === SSE_TERMINATOR) completed = true;
    }
  };
  const inspectTrailingLine = (): void => {
    if (lineBuffer.replace(/\r$/, "") === SSE_TERMINATOR) completed = true;
  };

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const chunk = await reader.read();
        if (chunk.done) {
          inspectLines(decoder.decode());
          inspectTrailingLine();
          controller.close();
          return;
        }
        bytes += chunk.value.byteLength;
        inspectLines(decoder.decode(chunk.value, { stream: true }));
        controller.enqueue(chunk.value);
      } catch (error) {
        inspectTrailingLine();
        if (!completed) {
          controller.error(error);
          return;
        }
        onUncleanClose?.(bytes);
        controller.close();
      }
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
}
