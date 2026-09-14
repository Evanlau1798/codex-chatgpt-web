import packageMetadata from "../package.json" with { type: "json" };

export const VERSION = packageMetadata.version;
