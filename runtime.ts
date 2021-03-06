// Copyright 2018 Ryan Dahl <ry@tinyclouds.org>
// All rights reserved. MIT License.
// Glossary
// outputCode = generated javascript code
// sourceCode = typescript code (or input javascript code)
// moduleName = a resolved module name
// fileName = an unresolved raw fileName.
//            for http modules , its the path to the locally downloaded
//            version.

import * as ts from "typescript";
import * as util from "./util";
import { log } from "./util";
import * as os from "./os";
import { pub, sub } from "./dispatch";
import * as sourceMaps from "./v8_source_maps";
import { _global, globalEval } from "./globals";

const EOL = "\n";

// Public deno module.
const deno = {
  pub,
  sub,
  readFileSync: os.readFileSync,
  writeFileSync: os.writeFileSync
};

// tslint:disable-next-line:no-any
type AmdFactory = (...args: any[]) => undefined | object;
type AmdDefine = (deps: string[], factory: AmdFactory) => void;

// Uncaught exceptions are sent to window.onerror by v8worker2.
// https://git.io/vhOsf
window.onerror = (message, source, lineno, colno, error) => {
  // TODO Currently there is a bug in v8_source_maps.ts that causes a segfault
  // if it is used within window.onerror. To workaround we uninstall the
  // Error.prepareStackTrace handler. Users will get unmapped stack traces on
  // uncaught exceptions until this issue is fixed.
  Error.prepareStackTrace = null;
  console.log(error.message, error.stack);
  os.exit(1);
};

export function setup(mainJs: string, mainMap: string): void {
  sourceMaps.install({
    installPrepareStackTrace: true,
    getGeneratedContents: (filename: string): string => {
      if (filename === "/main.js") {
        return mainJs;
      } else if (filename === "/main.map") {
        return mainMap;
      } else {
        const mod = FileModule.load(filename);
        if (!mod) {
          console.error("getGeneratedContents cannot find", filename);
        }
        return mod.outputCode;
      }
    }
  });
}

// This class represents a module. We call it FileModule to make it explicit
// that each module represents a single file.
// Access to FileModule instances should only be done thru the static method
// FileModule.load(). FileModules are NOT executed upon first load, only when
// compileAndRun is called.
export class FileModule {
  scriptVersion: string = undefined;
  readonly exports = {};

  private static readonly map = new Map<string, FileModule>();
  constructor(
    readonly fileName: string,
    readonly sourceCode = "",
    public outputCode = ""
  ) {
    util.assert(
      !FileModule.map.has(fileName),
      `FileModule.map already has ${fileName}`
    );
    FileModule.map.set(fileName, this);
    if (outputCode !== "") {
      this.scriptVersion = "1";
    }
  }

  compileAndRun(): void {
    if (!this.outputCode) {
      // If there is no cached outputCode, the compile the code.
      util.assert(
        this.sourceCode != null && this.sourceCode.length > 0,
        `Have no source code from ${this.fileName}`
      );
      const compiler = Compiler.instance();
      this.outputCode = compiler.compile(this.fileName);
      os.codeCache(this.fileName, this.sourceCode, this.outputCode);
    }
    util.log("compileAndRun", this.sourceCode);
    execute(this.fileName, this.outputCode);
  }

  static load(fileName: string): FileModule {
    return this.map.get(fileName);
  }

  static getScriptsWithSourceCode(): string[] {
    const out = [];
    for (const fn of this.map.keys()) {
      const m = this.map.get(fn);
      if (m.sourceCode) {
        out.push(fn);
      }
    }
    return out;
  }
}

export function makeDefine(fileName: string): AmdDefine {
  const localDefine = (deps: string[], factory: AmdFactory): void => {
    const localRequire = (x: string) => {
      log("localRequire", x);
    };
    const currentModule = FileModule.load(fileName);
    const localExports = currentModule.exports;
    log("localDefine", fileName, deps, localExports);
    const args = deps.map(dep => {
      if (dep === "require") {
        return localRequire;
      } else if (dep === "exports") {
        return localExports;
      } else if (dep === "deno") {
        return deno;
      } else {
        const resolved = resolveModuleName(dep, fileName);
        const depModule = FileModule.load(resolved);
        depModule.compileAndRun();
        return depModule.exports;
      }
    });
    factory(...args);
  };
  return localDefine;
}

export function resolveModule(
  moduleSpecifier: string,
  containingFile: string
): null | FileModule {
  //util.log("resolveModule", { moduleSpecifier, containingFile });
  util.assert(moduleSpecifier != null && moduleSpecifier.length > 0);
  // We ask golang to sourceCodeFetch. It will load the sourceCode and if
  // there is any outputCode cached, it will return that as well.
  const { filename, sourceCode, outputCode } = os.codeFetch(
    moduleSpecifier,
    containingFile
  );
  if (sourceCode.length === 0) {
    return null;
  }
  util.log("resolveModule sourceCode length ", sourceCode.length);
  const m = FileModule.load(filename);
  if (m != null) {
    return m;
  } else {
    return new FileModule(filename, sourceCode, outputCode);
  }
}

function resolveModuleName(
  moduleSpecifier: string,
  containingFile: string
): string {
  const mod = resolveModule(moduleSpecifier, containingFile);
  return mod.fileName;
}

function execute(fileName: string, outputCode: string): void {
  util.assert(outputCode && outputCode.length > 0);
  _global["define"] = makeDefine(fileName);
  outputCode += "\n//# sourceURL=" + fileName;
  globalEval(outputCode);
  _global["define"] = null;
}

// This is a singleton class. Use Compiler.instance() to access.
class Compiler {
  options: ts.CompilerOptions = {
    allowJs: true,
    module: ts.ModuleKind.AMD,
    outDir: "$deno$",
    inlineSourceMap: true,
    lib: ["es2017"],
    inlineSources: true,
    target: ts.ScriptTarget.ES2017
  };
  /*
  allowJs: true,
  module: ts.ModuleKind.AMD,
  noEmit: false,
  outDir: '$deno$',
  */
  private service: ts.LanguageService;

  private constructor() {
    const host = new TypeScriptHost(this.options);
    this.service = ts.createLanguageService(host);
  }

  private static _instance: Compiler;
  static instance(): Compiler {
    return this._instance || (this._instance = new this());
  }

  compile(fileName: string): string {
    const output = this.service.getEmitOutput(fileName);

    // Get the relevant diagnostics - this is 3x faster than
    // `getPreEmitDiagnostics`.
    const diagnostics = this.service
      .getCompilerOptionsDiagnostics()
      .concat(this.service.getSyntacticDiagnostics(fileName))
      .concat(this.service.getSemanticDiagnostics(fileName));
    if (diagnostics.length > 0) {
      const errMsg = ts.formatDiagnosticsWithColorAndContext(
        diagnostics,
        formatDiagnosticsHost
      );
      console.log(errMsg);
      os.exit(1);
    }

    util.assert(!output.emitSkipped);

    const outputCode = output.outputFiles[0].text;
    // let sourceMapCode = output.outputFiles[0].text;
    return outputCode;
  }
}

// Create the compiler host for type checking.
class TypeScriptHost implements ts.LanguageServiceHost {
  constructor(readonly options: ts.CompilerOptions) {}

  getScriptFileNames(): string[] {
    const keys = FileModule.getScriptsWithSourceCode();
    util.log("getScriptFileNames", keys);
    return keys;
  }

  getScriptVersion(fileName: string): string {
    util.log("getScriptVersion", fileName);
    const m = FileModule.load(fileName);
    return m.scriptVersion;
  }

  getScriptSnapshot(fileName: string): ts.IScriptSnapshot | undefined {
    util.log("getScriptSnapshot", fileName);
    const m = resolveModule(fileName, ".");
    if (m == null) {
      util.log("getScriptSnapshot", fileName, "NOT FOUND");
      return undefined;
    }
    //const m = resolveModule(fileName, ".");
    util.assert(m.sourceCode.length > 0);
    return ts.ScriptSnapshot.fromString(m.sourceCode);
  }

  fileExists(fileName: string): boolean {
    const m = resolveModule(fileName, ".");
    const exists = m != null;
    util.log("fileExist", fileName, exists);
    return exists;
  }

  readFile(path: string, encoding?: string): string | undefined {
    util.log("readFile", path);
    throw Error("not implemented");
  }

  getNewLine() {
    return EOL;
  }

  getCurrentDirectory() {
    util.log("getCurrentDirectory");
    return ".";
  }

  getCompilationSettings() {
    util.log("getCompilationSettings");
    return this.options;
  }

  getDefaultLibFileName(options: ts.CompilerOptions): string {
    const fn = ts.getDefaultLibFileName(options);
    util.log("getDefaultLibFileName", fn);
    const m = resolveModule(fn, "/$asset$/");
    return m.fileName;
  }

  resolveModuleNames(
    moduleNames: string[],
    containingFile: string,
    reusedNames?: string[]
  ): Array<ts.ResolvedModule | undefined> {
    //util.log("resolveModuleNames", { moduleNames, reusedNames });
    return moduleNames.map((name: string) => {
      let resolvedFileName;
      if (name === "deno") {
        resolvedFileName = resolveModuleName("deno.d.ts", "/$asset$/");
      } else {
        resolvedFileName = resolveModuleName(name, containingFile);
      }
      const isExternalLibraryImport = false;
      return { resolvedFileName, isExternalLibraryImport };
    });
  }
}

const formatDiagnosticsHost: ts.FormatDiagnosticsHost = {
  getCurrentDirectory(): string {
    return ".";
  },
  getCanonicalFileName(fileName: string): string {
    return fileName;
  },
  getNewLine(): string {
    return EOL;
  }
};
