import { expect, spyOn, test } from "bun:test";
import { defaultConfig } from "../src/config";
import * as browser from "../src/launcher-browser-host";
import { inspectDoctorLauncher } from "../src/doctor";

test("native doctor never runs authentication navigation before the guarded inspection", async () => {
  const config = defaultConfig("full");
  config.browserHost = "launcher";
  config.browserInteractionMode = "automatic";
  config.browserHostDescriptorPath = "/unused-fixture-descriptor";
  const descriptor = { pid: 123 } as never;
  const liveness = spyOn(browser, "inspectLauncherBrowserHostLiveness").mockResolvedValue(descriptor);
  const authenticated = spyOn(browser, "inspectLauncherBrowserHost").mockRejectedValue(new Error("navigation must not run"));
  const read = spyOn(browser, "readLauncherBrowserHostDescriptor").mockReturnValue(descriptor);
  try {
    expect(await inspectDoctorLauncher(config, true)).toBe(descriptor);
    expect(liveness).toHaveBeenCalledTimes(1);
    expect(authenticated).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
  } finally { liveness.mockRestore(); authenticated.mockRestore(); read.mockRestore(); }
});
