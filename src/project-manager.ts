import * as path_ from 'path';
import * as fs_ from 'fs';
import * as os from 'os';

import * as ts from 'typescript';
import { IConnection, PublishDiagnosticsParams } from 'vscode-languageserver';
import * as async from 'async';

import * as FileSystem from './fs';
import * as util from './util';
import * as match from './match-files';

/**
 * ProjectManager translates VFS files to one or many projects denoted by [tj]config.json.
 * It uses either local or remote file system to fetch directory tree and files from and then
 * makes one or more LanguageService objects. By default all LanguageService objects contain no files,
 * they are added on demand - current file for hover or definition, project's files for references and 
 * all files from all projects for workspace symbols.
 */
export class ProjectManager {

	private root: string;
	private configs: Map<string, ProjectConfiguration>;
	private strict: boolean;

	private remoteFs: FileSystem.FileSystem;
	private localFs: InMemoryFileSystem;

	private versions: Map<string, number>;
    /**
     * fetched keeps track of which files in localFs have actually
     * been fetched from remoteFs. Some might have a placeholder
     * value.
     */
	private fetched: Set<string>;

	constructor(root: string, remoteFs: FileSystem.FileSystem, strict: boolean) {
		this.root = util.normalizePath(root);
		this.configs = new Map<string, ProjectConfiguration>();
		this.localFs = new InMemoryFileSystem(this.root);
		this.versions = new Map<string, number>();
		this.fetched = new Set<string>();
		this.remoteFs = remoteFs;
		this.strict = strict;
	}

	getRemoteRoot(): string {
		return this.root;
	}


	getFs(): InMemoryFileSystem {
		return this.localFs;
	}

	/**
	 * @return true if there is a file with a given name
	 */
	hasFile(name: string) {
		return this.localFs.fileExists(name);
	}

	/**
	 * @return all projects
	 */
	getConfigurations(): ProjectConfiguration[] {
		const ret = [];
		this.configs.forEach((v, k) => {
			ret.push(v);
		});
		return ret;
	}

	// TODO: eliminate this method
	// we should process all subprojects instead
	getAnyConfiguration(): ProjectConfiguration {
		let config = null;
		this.configs.forEach((v) => {
			if (!config) {
				config = v;
			}
		});
		return config;
	}

	private ensuredModuleStructure: Promise<void> = null;

    /**
     * ensureModuleStructure ensures that the module structure of the
     * project exists in localFs. TypeScript/JavaScript module
     * structure is determined by [jt]sconfig.json, filesystem layout,
     * global*.d.ts files. For performance reasons, we only read in
     * the contents of some files and store "var dummy_0ff1bd;" as the
     * contents of all other files.
     */
	ensureModuleStructure(): Promise<void> {
		if (!this.ensuredModuleStructure) {
			this.ensuredModuleStructure = this.refreshModuleStructureAt(this.root).then(() => {
				this.refreshConfigurations();
			});
			this.ensuredModuleStructure.catch((err) => {
				console.error("Failed to fetch module structure:", err);
				this.ensuredModuleStructure = null;
			});
		}
		return this.ensuredModuleStructure;
	}

	/*
	 * refreshModuleStructureAt refreshes the local in-memory
	 * filesytem's (this.localFs) files under the specified path
	 * (root) with the contents of the remote filesystem
	 * (this.remoteFs). It will also reset the ProjectConfigurations
	 * that are affected by the refreshed files.
	 *
	 * This method is public because a ProjectManager instance assumes
	 * there are no changes made to the remote filesystem structure
	 * after initialization. If such changes are made, it is necessary
	 * to call this method to alert the ProjectManager instance of the
	 * change.
	 */
	async refreshModuleStructureAt(root: string): Promise<void> {
		if (!root.startsWith('/')) {
			root = '/' + root;
		}
		if (root !== '/' && root.endsWith('/')) {
			root = root.substring(0, root.length - 1);
		}
		const start = new Date().getTime();
		const self = this;
		const filesToFetch = [];
		await this.walkRemote(root, function (path: string, info: FileSystem.FileInfo, err?: Error): (Error | null) {
			if (err) {
				return err;
			} else if (info.dir) {
				return null;
			}
			const rel = path_.posix.relative(self.root, util.normalizePath(path));
			if (util.isGlobalTSFile(rel) || util.isConfigFile(rel) || util.isPackageJsonFile(rel)) {
				filesToFetch.push(path);
			} else {
				if (!self.localFs.fileExists(rel)) {
					self.localFs.addFile(rel, localFSPlaceholder);
				}
			}
			return null;
		});
		await this.ensureFiles(filesToFetch);

		// require re-fetching of dependency files (but not for
		// workspace/symbol and textDocument/references, because those
		// should not be affected by new external modules)
		this.ensuredFilesForHoverAndDefinition.clear();

		// require re-parsing of projects whose file set may have been affected
		for (let [dir, config] of this.configs) {
			if (!dir.startsWith('/')) {
				dir = '/' + dir;
			}
			if (dir !== '/' && dir.endsWith('/')) {
				dir = dir.substring(0, dir.length - 1);
			}

			if (dir.startsWith(root + '/') || root.startsWith(dir + '/') || root === dir) {
				config.reset();
			}
		}
	}

	private ensuredFilesForHoverAndDefinition = new Map<string, Promise<void>>();

	ensureFilesForHoverAndDefinition(uri: string): Promise<void> {
		if (this.ensuredFilesForHoverAndDefinition.get(uri)) {
			return this.ensuredFilesForHoverAndDefinition.get(uri);
		}

		const promise = this.ensureModuleStructure().then(() => {
			// include dependencies up to depth 30
			const deps = new Set<string>();
			return this.ensureTransitiveFileDependencies([util.uri2path(uri)], 30, deps).then(() => {
				return this.refreshConfigurations();
			});
		});
		this.ensuredFilesForHoverAndDefinition.set(uri, promise);
		promise.catch((err) => {
			console.error("Failed to fetch files for hover/definition for uri ", uri, ", error:", err);
			this.ensuredFilesForHoverAndDefinition.delete(uri);
		});
		return promise;
	}

	private ensuredFilesForWorkspaceSymbol: Promise<void> = null;

	ensureFilesForWorkspaceSymbol(): Promise<void> {
		if (this.ensuredFilesForWorkspaceSymbol) {
			return this.ensuredFilesForWorkspaceSymbol;
		}

		const self = this;
		const filesToEnsure = [];
		const promise = this.walkRemote(this.getRemoteRoot(), function (path: string, info: FileSystem.FileInfo, err?: Error): (Error | null) {
			if (err) {
				return err;
			} else if (info.dir) {
				if (util.normalizePath(info.name).indexOf(`${path_.posix.sep}node_modules${path_.posix.sep}`) !== -1) {
					return skipDir;
				} else {
					return null;
				}
			}
			if (util.isJSTSFile(path) || util.isConfigFile(path) || util.isPackageJsonFile(path)) {
				filesToEnsure.push(path);
			}
			return null;
		}).then(() => {
			return this.ensureFiles(filesToEnsure)
		}).then(() => {
			return this.refreshConfigurations();
		});

		this.ensuredFilesForWorkspaceSymbol = promise;
		promise.catch((err) => {
			console.error("Failed to fetch files for workspace/symbol:", err);
			this.ensuredFilesForWorkspaceSymbol = null;
		});

		return promise;
	}

	private ensuredAllFiles: Promise<void> = null;

	ensureFilesForReferences(uri: string): Promise<void> {
		const fileName: string = util.uri2path(uri);
		if (util.normalizePath(fileName).indexOf(`${path_.posix.sep}node_modules${path_.posix.sep}`) !== -1) {
			return this.ensureFilesForWorkspaceSymbol();
		}

		if (this.ensuredAllFiles) {
			return this.ensuredAllFiles;
		}

		const filesToEnsure = [];
		const promise = this.walkRemote(this.getRemoteRoot(), function (path: string, info: FileSystem.FileInfo, err?: Error): (Error | null) {
			if (err) {
				return err;
			} else if (info.dir) {
				return null;
			}
			if (util.isJSTSFile(path)) {
				filesToEnsure.push(path);
			}
			return null;
		}).then(() => {
			return this.ensureFiles(filesToEnsure)
		}).then(() => {
			return this.refreshConfigurations();
		});

		this.ensuredAllFiles = promise;
		promise.catch((err) => {
			console.error("Failed to fetch files for references:", err);
			this.ensuredAllFiles = null;
		});

		return promise;
	}

	private async ensureTransitiveFileDependencies(fileNames: string[], maxDepth: number, seen: Set<string>): Promise<void> {
		fileNames = fileNames.filter((f) => !seen.has(f));
		if (fileNames.length === 0) {
			return Promise.resolve();
		}
		fileNames.forEach((f) => seen.add(f));

		const absFileNames = fileNames.map((f) => util.normalizePath(util.resolve(this.root, f)));
		await this.ensureFiles(absFileNames);

		if (maxDepth > 0) {
			const importFiles = new Set<string>();
			await Promise.all(fileNames.map(async (fileName) => {
				const config = this.getConfiguration(fileName);
				await config.ensureBasicFiles();
				const contents = this.getFs().readFile(fileName) || '';
				const info = ts.preProcessFile(contents, true, true);
				const compilerOpt = config.host.getCompilationSettings();
				for (const imp of info.importedFiles) {
					const resolved = ts.resolveModuleName(imp.fileName, fileName, compilerOpt, config.moduleResolutionHost());
					if (!resolved || !resolved.resolvedModule) {
						// This means we didn't find a file defining
						// the module. It could still exist as an
						// ambient module, which is why we fetch
						// global*.d.ts files.
						continue;
					}
					importFiles.add(resolved.resolvedModule.resolvedFileName);
				}
				const resolver = !this.strict && os.platform() == 'win32' ? path_ : path_.posix;
				for (const ref of info.referencedFiles) {
					// Resolving triple slash references relative to current file
					// instead of using module resolution host because it behaves
					// differently in "nodejs" mode
					const refFileName = util.normalizePath(path_.relative(this.root,
						resolver.resolve(this.root,
							resolver.dirname(fileName),
							ref.fileName)));
					importFiles.add(refFileName);
				}
			}));
			await this.ensureTransitiveFileDependencies(Array.from(importFiles), maxDepth - 1, seen);
		};
	}

    /**
     * ensureFiles ensures the following files have been fetched to
     * localFs. The files parameter is expected to contain paths in
     * the remote FS. ensureFiles only syncs unfetched file content
     * from remoteFs to localFs. It does not update project
     * state. Callers that want to do so after file contents have been
     * fetched should call this.refreshConfigurations().
     */
	ensureFiles(files: string[]): Promise<void> {
		const filesToFetch = files.filter((f) => !this.fetched.has(f));
		if (filesToFetch.length === 0) {
			return Promise.resolve();
		}
		return new Promise<void>((resolve, reject) => {
			this.fetchContent(filesToFetch, (err) => {
				if (err) {
					return reject(err);
				}
				filesToFetch.forEach((f) => this.fetched.add(util.normalizePath(f)));
				return resolve();
			});
		});
	}

	walkRemote(root: string, walkfn: (path: string, info: FileSystem.FileInfo, err?: Error) => Error | null): Promise<void> {
		const info = {
			name: root,
			size: 0,
			dir: true,
		}
		return this.walkRemoter(root, info, walkfn);
	}

	private walkRemoter(path: string, info: FileSystem.FileInfo, walkfn: (path: string, info: FileSystem.FileInfo, err?: Error) => Error | null): Promise<void> {
		if (info.name.indexOf('/.') >= 0) {
			return Promise.resolve();
		}

		const err = walkfn(path, info);
		if (err === skipDir) {
			return Promise.resolve();
		} else if (err) {
			return Promise.reject(err);
		}

		if (!info.dir) {
			return Promise.resolve();
		}

		return new Promise<void>((resolve, reject) => {
			this.fetchDir(path)((err: Error, result?: FileSystem.FileInfo[]) => {
				if (err) {
					const err2 = walkfn(path, info, err);
					if (err2) {
						return reject(err);
					} else {
						return resolve();
					}
				}

				Promise.all(result.map((fi) => this.walkRemoter(fi.name, fi, walkfn))).then(() => {
					return resolve();
				}, (err) => {
					return reject(err);
				});
			});
		});
	}


	/**
	 * @return project configuration for a given source file. Climbs directory tree up to workspace root if needed 
	 */
	getConfiguration(fileName: string): ProjectConfiguration {
		let dir = path_.posix.dirname(fileName);
		let config;
		while (dir && dir != this.root) {
			config = this.configs.get(dir);
			if (config) {
				return config;
			}
			dir = path_.posix.dirname(dir);
			if (dir == '.') {
				dir = '';
			}
		}
		return this.configs.get('');
	}

	didOpen(fileName: string, text: string) {
		this.didChange(fileName, text);
	}

	didClose(fileName: string) {
		this.localFs.didClose(fileName);
		let version = this.versions.get(fileName) || 0;
		this.versions.set(fileName, ++version);
		const config = this.getConfiguration(fileName)
		config.ensureConfigFile().then(() => {
			config.host.incProjectVersion();
			config.program = config.service.getProgram();
		});
	}

	didChange(fileName: string, text: string) {
		this.localFs.didChange(fileName, text);
		let version = this.versions.get(fileName) || 0;
		this.versions.set(fileName, ++version);
		const config = this.getConfiguration(fileName)
		config.ensureConfigFile().then(() => {
			config.host.incProjectVersion();
			config.program = config.service.getProgram();
		});
	}

	didSave(fileName: string) {
		this.localFs.didSave(fileName);
	}


    /**
     * @return asynchronous function that fetches directory content from VFS
     */
	private fetchDir(path: string): AsyncFunction<FileSystem.FileInfo[], Error> {
		return (callback: (err?: Error, result?: FileSystem.FileInfo[]) => void) => {
			this.remoteFs.readDir(path, (err?: Error, result?: FileSystem.FileInfo[]) => {
				if (result) {
					result.forEach((fi) => {
						fi.name = path_.posix.join(path, fi.name)
					})
				}
				return callback(err, result)
			});
		}
	}

    /**
     * Fetches content of the specified files
     */
	private fetchContent(files: string[], callback: (err?: Error) => void) {
		if (!files || files.length === 0) {
			return callback();
		}

		const fetch = (path: string): AsyncFunction<string, Error> => {
			return (callback: (err?: Error, result?: string) => void) => {
				this.remoteFs.readFile(path, (err?: Error, result?: string) => {
					if (err) {
						console.error('Unable to fetch content of ' + path, err);
						// There is a chance that we request not-existent file.
						result = '';
					}
					const rel = path_.posix.relative(this.root, path);
					this.localFs.addFile(rel, result);
					return callback()
				})
			}
		};
		let tasks = files.map(fetch);
		const start = new Date().getTime();
		// Why parallelLimit: There may be too many open files when working with local FS and trying
		// to open them in parallel
		async.parallelLimit(tasks, 100, (err) => {
			console.error('files fetched in', (new Date().getTime() - start) / 1000.0);
			return callback(err);
		});
	}

    /**
     * Detects projects and creates projects denoted by tsconfig.json. Previously detected projects are discarded.
     */
	refreshConfigurations() {
		const rootdirs = new Set<string>();
		Object.keys(this.localFs.entries).forEach((k) => {
			if (!/(^|\/)[tj]sconfig\.json$/.test(k)) {
				return;
			}
			if (/(^|\/)node_modules\//.test(k)) {
				return;
			}
			let dir = path_.posix.dirname(k);
			if (dir == '.') {
				dir = '';
			}
			this.configs.set(dir, new ProjectConfiguration(this.localFs, this.versions, k));
			rootdirs.add(dir);
		});
		if (!rootdirs.has('')) {
			// collecting all the files in workspace by making fake configuration object
			this.configs.set('', new ProjectConfiguration(this.localFs, this.versions, '', {
				compilerOptions: {
					module: ts.ModuleKind.CommonJS,
					allowNonTsExtensions: false,
					allowJs: true
				}
			}));
		}
	}
}

/**
 * Implementaton of LanguageServiceHost that works with in-memory file system
 */
export class InMemoryLanguageServiceHost implements ts.LanguageServiceHost {

	complete: boolean;

	private root: string;
	private options: ts.CompilerOptions;
	private fs: InMemoryFileSystem;
	expectedFiles: string[];

	private files: string[];

	private projectVersion: number;

	private versions: Map<string, number>;

	constructor(root: string, options: ts.CompilerOptions, fs: InMemoryFileSystem, expectedFiles: string[], versions: Map<string, number>) {
		this.root = root;
		this.options = options;
		this.fs = fs;
		this.expectedFiles = expectedFiles;
		this.versions = versions;
		this.projectVersion = 1;
		this.files = [];
		// adding library files from the local file system
		getTypeScriptLibraries().forEach((content, name) => {
			this.fs.entries[name] = content;
		});
	}

    /**
     * TypeScript uses this method (when present) to compare project's version 
     * with the last known one to decide if internal data should be synchronized
     */
	getProjectVersion(): string {
		return '' + this.projectVersion;
	}

	incProjectVersion() {
		this.projectVersion++;
	}

	getCompilationSettings(): ts.CompilerOptions {
		return this.options;
	}

	getScriptFileNames(): string[] {
		return this.files;
	}

    /**
     * Adds a file and increments project version, used in conjunction with getProjectVersion()
     * which may be called by TypeScript to check if internal data is up to date
     */
	addFile(fileName: string) {
		this.files.push(fileName);
		this.incProjectVersion();
	}

	getScriptVersion(fileName: string): string {
		if (path_.posix.isAbsolute(fileName) || path_.isAbsolute(fileName)) {
			fileName = path_.posix.relative(this.root, util.normalizePath(fileName));
		}
		let version = this.versions.get(fileName);
		if (!version) {
			version = 1;
			this.versions.set(fileName, version);
		}
		return "" + version;
	}

	getScriptSnapshot(fileName: string): ts.IScriptSnapshot {
		let entry = this.fs.readFile(fileName);
		if (!entry) {
			fileName = path_.posix.relative(this.root, fileName);
			entry = this.fs.readFile(fileName);
		}
		if (!entry) {
			return undefined;
		}
		return ts.ScriptSnapshot.fromString(entry);
	}

	getCurrentDirectory(): string {
		return this.root;
	}

	getDefaultLibFileName(options: ts.CompilerOptions): string {
		return util.normalizePath(ts.getDefaultLibFilePath(options));
	}

	trace(message: string) {
		console.error(message);
	}

	log(message: string) {
		console.error(message);
	}

	error(message: string) {
		console.error(message);
	}


}

const localFSPlaceholder = "var dummy_0ff1bd;";

/**
 * In-memory file system, can be served as a ParseConfigHost (thus allowing listing files that belong to project based on tsconfig.json options)
 */
export class InMemoryFileSystem implements ts.ParseConfigHost, ts.ModuleResolutionHost {

	entries: any;
	overlay: any;
	useCaseSensitiveFileNames: boolean;
	path: string;

	private rootNode: any;

	constructor(path: string) {
		this.path = path;
		this.entries = {};
		this.overlay = {};
		this.rootNode = {};
	}

	addFile(path: string, content: string) {
		this.entries[path] = content;
		let node = this.rootNode;
		path.split('/').forEach((component, i, components) => {
			const n = node[component];
			if (!n) {
				node[component] = (i === components.length - 1) ? '*' : {};
				node = node[component];
			} else {
				node = n;
			}
		});
	}

	fileExists(path: string): boolean {
		return this.readFile(path) !== undefined;
	}

	readFile(path: string): string {
		let content = this.overlay[path];
		if (content !== undefined) {
			return content;
		}

		const rel = path_.posix.relative('/', path);

		content = this.overlay[rel];
		if (content !== undefined) {
			return content;
		}

		content = this.entries[path];
		if (content !== undefined) {
			return content;
		}

		return this.entries[rel];
	}

	didClose(path: string) {
		delete this.overlay[path];
	}

	didSave(path: string) {
		this.addFile(path, this.readFile(path));
	}

	didChange(path: string, text: string) {
		this.overlay[path] = text;
	}

	readDirectory(rootDir: string, extensions: string[], excludes: string[], includes: string[]): string[] {
		return match.matchFiles(rootDir,
			extensions,
			excludes,
			includes,
			true,
			this.path,
			(p) => this.getFileSystemEntries(p));
	}

	getFileSystemEntries(path: string): match.FileSystemEntries {
		path = path_.posix.relative(this.path, path);
		const ret = { files: [], directories: [] };
		let node = this.rootNode;
		const components = path.split('/');
		if (components.length != 1 || components[0]) {
			components.forEach((component) => {
				const n = node[component];
				if (!n) {
					return ret;
				}
				node = n;
			});
		}
		Object.keys(node).forEach((name) => {
			if (typeof node[name] == 'string') {
				ret.files.push(name);
			} else {
				ret.directories.push(name);
			}
		});
		return ret;
	}

	trace(message: string) {
		console.error(message);
	}
}

/**
 * ProjectConfiguration instances track the compiler configuration (as
 * defined by {tj}sconfig.json if it exists) and state for a single
 * TypeScript project. It represents the world of the view as
 * presented to the compiler.
 *
 * For efficiency, a ProjectConfiguration instance may hide some files
 * from the compiler, preventing them from being parsed and
 * type-checked. Depending on the use, the caller should call one of
 * the ensure* methods to ensure that the appropriate files have been
 * made available to the compiler before calling any other methods on
 * the ProjectConfiguration or its public members. By default, no
 * files are parsed.
 */
export class ProjectConfiguration {

	service: ts.LanguageService;

	// program is "a collection of SourceFiles and a set of
	// compilation options that represent a compilation unit. The
	// program is the main entry point to the type system and code
	// generation."
	// (https://github.com/Microsoft/TypeScript-wiki/blob/master/Architectural-Overview.md#data-structures)
	program: ts.Program;

	host: InMemoryLanguageServiceHost;

	private fs: InMemoryFileSystem;
	private configFileName: string;
	private configContent: any;
	private versions: Map<string, number>;

    /**
     * @param fs file system to use
     * @param configFileName configuration file name (relative to workspace root)
     * @param configContent optional configuration content to use instead of reading configuration file)
     */
	constructor(fs: InMemoryFileSystem, versions: Map<string, number>, configFileName: string, configContent?: any) {
		this.fs = fs;
		this.configFileName = configFileName;
		this.configContent = configContent;
		this.versions = versions;
	}

	moduleResolutionHost(): ts.ModuleResolutionHost {
		return this.fs;
	}

	/**
	 * reset resets a ProjectConfiguration to its state immediately
	 * after construction. It should be called whenever the underlying
	 * local filesystem (fs) has changed, and so the
	 * ProjectConfiguration can no longer assume its state reflects
	 * that of the underlying files.
	 */
	reset(): void {
		this.initialized = null;
		this.ensuredBasicFiles = null;
		this.ensuredAllFiles = null;
		this.service = null;
		this.program = null;
		this.host = null;
	}

	private initialized: Promise<void>;

	private init(): Promise<void> {
		if (this.initialized) {
			return this.initialized;
		}
		this.initialized = new Promise<void>((resolve, reject) => {
			let configObject;
			if (!this.configContent) {
				const jsonConfig = ts.parseConfigFileTextToJson(this.configFileName, this.fs.readFile(this.configFileName));
				if (jsonConfig.error) {
					console.error('Cannot parse ' + this.configFileName + ': ' + jsonConfig.error.messageText);
					return reject(new Error('Cannot parse ' + this.configFileName + ': ' + jsonConfig.error.messageText));
				}
				configObject = jsonConfig.config;
			} else {
				configObject = this.configContent;
			}
			let dir = path_.posix.dirname(this.configFileName);
			if (dir == '.') {
				dir = '';
			}
			const base = dir || this.fs.path;
			const configParseResult = ts.parseJsonConfigFileContent(configObject, this.fs, base);
			const options = configParseResult.options;
			if (/(^|\/)jsconfig\.json$/.test(this.configFileName)) {
				options.allowJs = true;
			}
			this.host = new InMemoryLanguageServiceHost(this.fs.path,
				options,
				this.fs,
				configParseResult.fileNames,
				this.versions);
			this.service = ts.createLanguageService(this.host, ts.createDocumentRegistry());
			this.program = this.service.getProgram();
			return resolve();
		});
		return this.initialized;
	}

	ensureConfigFile(): Promise<void> {
		return this.init();
	}

	private ensuredBasicFiles: Promise<void>;

	async ensureBasicFiles(): Promise<void> {
		if (this.ensuredBasicFiles) {
			return this.ensuredBasicFiles;
		}

		this.ensuredBasicFiles = this.init().then(() => {
			let changed = false;
			for (const fileName of (this.host.expectedFiles || [])) {
				if (fileName.startsWith("/typings/") || fileName.startsWith("typings/")) {
					const sourceFile = this.program.getSourceFile(fileName);
					if (!sourceFile) {
						this.host.addFile(fileName);
						changed = true;
					}
				}
			}
			if (changed) {
				// requery program object to synchonize LanguageService's data
				this.program = this.service.getProgram();
			}
		});
		return this.ensuredBasicFiles;
	}

	private ensuredAllFiles: Promise<void>;

	async ensureAllFiles(): Promise<void> {
		if (this.ensuredAllFiles) {
			return this.ensuredAllFiles;
		}

		this.ensuredAllFiles = this.init().then(() => {
			if (this.host.complete) {
				return;
			}
			let changed = false;
			for (const fileName of (this.host.expectedFiles || [])) {
				const sourceFile = this.program.getSourceFile(fileName);
				if (!sourceFile) {
					this.host.addFile(fileName);
					changed = true;
				}
			}
			if (changed) {
				// requery program object to synchonize LanguageService's data
				this.program = this.service.getProgram();
			}
			this.host.complete = true;
		});
		return this.ensuredAllFiles;
	}
}

export const skipDir: Error = {
	name: "WALK_FN_SKIP_DIR",
	message: "",
}

var tsLibraries: Map<string, string>;

/**
 * Fetches TypeScript library files from local file system
 */
export function getTypeScriptLibraries(): Map<string, string> {
	if (!tsLibraries) {
		tsLibraries = new Map<string, string>();
		const path = path_.dirname(ts.getDefaultLibFilePath({ target: ts.ScriptTarget.ES2015 }));
		fs_.readdirSync(path).forEach((file) => {
			const fullPath = path_.join(path, file);
			if (fs_.statSync(fullPath).isFile()) {
				tsLibraries.set(util.normalizePath(fullPath), fs_.readFileSync(fullPath).toString());
			}
		});
	}
	return tsLibraries;
}
