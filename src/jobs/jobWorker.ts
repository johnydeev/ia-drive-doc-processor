import Module from "module";
import path from "path";

const distRoot = path.resolve(__dirname, "..", "..");
const ModuleAny = Module as any;
const originalResolve = ModuleAny._resolveFilename as (
  request: string,
  parent: any,
  isMain: any,
  options: any
) => string;

ModuleAny._resolveFilename = function (
  request: string,
  parent: any,
  isMain: any,
  options: any
) {
  if (request.startsWith("@/")) {
    const target = path.join(distRoot, request.slice(2));
    return originalResolve.call(this, target, parent, isMain, options);
  }

  return originalResolve.call(this, request, parent, isMain, options);
};

// Load the compiled worker logic after alias patching.
// eslint-disable-next-line @typescript-eslint/no-require-imports
require("./jobWorkerMain");
