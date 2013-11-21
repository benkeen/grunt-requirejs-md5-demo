module.exports = function(grunt) {
	"use strict";

	// include some handy node functionality
	var fs = require('fs');
	var vm = require('vm');
	var _includeInThisScope = function (path) {
		var code = fs.readFileSync(path);
		vm.runInThisContext(code, path);
	}.bind(this);
	_includeInThisScope("build-templates/file-paths.js");
	_includeInThisScope("build-templates/bundling.js");


	// During the stage + prod builds, files are moved to the build folder and renamed to include their MD5 file
	// hash. This var is used in various subsequent steps to know what file is where
	var _componentNameToMD5Path = {};


	// Used during the stage + prod builds. This contains a map of [new bundled filename] => old location of source
	// file. It contains the core file (core-start) and whatever pages have been targeted for bundling in
	// build-templates/bundling.js
	var _renamedBundledFiles = {};

	var _getMD5PathMap = function() {
		var obj = {};
		for (var i in _requireJSModulePaths) {
			var path = _requireJSModulePaths[i];
			obj["build/" + path] = path;
		}
		return obj;
	};

	var _requireJSModulesJSOnly = function() {
		var filePaths = [];
		for (var i in _requireJSModulePaths) {
			if (_requireJSModulePaths[i].match(/\.js$/)) {
				filePaths.push(_requireJSModulePaths[i]);
			}
		}
		return filePaths;
	};

	var _getRequireConfigJSComponentList = function(params) {
		var isBundled = params.isBundled;
		var fileMap   = params.hasOwnProperty("fileMap") ? params.fileMap : {};

		var list = [];
		for (var i in _requireJSModulePaths) {
			var currPath = _requireJSModulePaths[i];

			// find the new md5-ified file + path
			if (isBundled) {
				currPath = fileMap[_requireJSModulePaths[i]];
			}

			// remove the trailing .js, because requireJS doesn't work with it (IMO one of requireJS's stupidest aspects)
			if (currPath) {
				currPath = currPath.replace(/\.js$/, "");
			} else {
				console.warn("***** Uh-oh. File specified in file-paths.js doesn't exist: ", i, "*****");
			}
			list.push('\t\t"' + i + '": "' + currPath + '"');

			// used in subsequent steps, hence the global
			_componentNameToMD5Path[i] = currPath;
		}

		return list.join(",\n");
	};

	/**
	 * The first step of the build process. This sets various settings in the main grunt config for the current build environment.
	 * These govern how the subsequent tasks behave.
	 */
	var _setBuildEnvironment = function(env) {
		config.template.main.options.data.ENV = env;

		var ENV_CONSTANTS = _CONSTANTS[env];
		config.template.main.options.data.C = ENV_CONSTANTS;
		config.template.recreateRequireConfig.options.data.C = ENV_CONSTANTS; // actually only used for Stage + Prod builds, but whatever

		// if this particular environment isn't being bundled, we don't need to do anything fancy to get
		// the require.config.js contents (i.e. md5 renaming and whatnot). For those that are, the componentList
		// data is populated later on when it's available.
		// N.B. *technically* this is a bug. This entire grunt file assumes that local + dev are NOT minified, and Stage and Prod ARE
		if (!ENV_CONSTANTS.MINIFIED) {
			config.template.main.options.data.componentList = _getRequireConfigJSComponentList({ bundled: false });
		}
	};


	/**
	 * This is the fussiest part of the whole build process, ran at the end of the stage and prod builds. It does two things:
	 *    1. bundles the core files and the individual pages.
	 *    2. renames the bundled files to ensure their file hash is actually correct, and re-updates core/require.config.js
	 *       to ensure everything's pointing to the right place.
	 *
	 * Unfortunately, #2 is necessary because the original file hash would have only contained the hash of the original, single
	 * file - not any (now-bundled) files in it. Doing this step at this stage is the least worst alternative because bundling
	 * with the optimizer REQUIRES the require.config.js to already have the paths in the build folder. So I think our options
	 * were limited, hence this fussy step of re-naming the bundled files & regenerating the require.config.js file with the new
	 * paths.
	 *
	 * One bright side of this is that it clearly renames the bundled files in the build folder so you can see in your browser's
	 * network panel what is and what is not bundled. Should be helpful down the road for figuring out optimizations.
	 */
	var _constructPageBundlingData = function() {

		// 1. bundle the Core
		_renamedBundledFiles["build/bundled-appStartBuild.js"] = _componentNameToMD5Path["appStartBuild"] + ".js";
		config.requirejs.core = {
			options: {
				name: "appStartBuild",
				out: _componentNameToMD5Path["appStartBuild"] + ".js",
				baseUrl: "./",
				mainConfigFile: "core/require.config.js"
			}
		};

		// 2. bundle the Pages
		for (var i=0; i<_componentsToBundle.length; i++) {
			if (!_componentNameToMD5Path.hasOwnProperty(_componentsToBundle[i])) {
				break;
			}

			_renamedBundledFiles["build/bundled-" + _componentsToBundle[i] + ".js"] = _componentNameToMD5Path[_componentsToBundle[i]] + ".js";
			config.requirejs["page" + i] = {
				options: {
					name: _componentsToBundle[i],
					out: _componentNameToMD5Path[_componentsToBundle[i]] + ".js",
					baseUrl: "./",
					mainConfigFile: "core/require.config.js",

					// this bit's a key optimization step. All this does is list a bunch of component that we KNOW will have already 
					// been loaded when the pages are loaded, so they're not unnecessarily added to each page bundle. To figure that
					// out, just look at core/core-start.js to see what's guaranteed to be included on all page loads
					exclude: [
						"constants",
						"handlebars",
						"hbs",
						"mediator",
						"pageManager",
						"streamGroupCollection",
						"userManager"
					]
				}
			};
		}

		// curious step, but this is needed for the MD5 task
		config.copy.bundledFiles.files = _renamedBundledFiles;
		var fileToFileMap = {};
		for (var file in _renamedBundledFiles) {
			fileToFileMap[file] = file;
		}
		config.md5.bundledFiles.files = fileToFileMap;
	};


	var _recreateRequireConfigFileForBundledFiles = function(bundledFileChanges) {

		// create a hash of the OLD md5 location to the new shiny md5, bundled location
		var oldToNew = {};
		for (var i=0; i<bundledFileChanges.length; i++) {
			oldToNew[bundledFileChanges[i].oldPath] = bundledFileChanges[i].newPath;
		}

		var hash = {};
		for (var bundledJSFileWithoutMD5 in _renamedBundledFiles) {
			var oldPath = _renamedBundledFiles[bundledJSFileWithoutMD5];
			var newPath = oldToNew[bundledJSFileWithoutMD5];
			hash[oldPath] = newPath;
		}

		var finalComponentList = [];
		for (var componentName in _componentNameToMD5Path) {
			var filePath = _componentNameToMD5Path[componentName];

			// if this component is one of the bundled ones, overwrite the file path with the new location
			if (hash.hasOwnProperty(filePath + ".js")) {
				filePath = hash[filePath + ".js"].replace(/\.js$/, "");
			}
			finalComponentList.push('\t\t"' + componentName + '": "' + filePath + '"');
		}

		config.template.recreateRequireConfig.options.data.componentList = finalComponentList.join(",\n");
		grunt.task.run("template:recreateRequireConfig");
	};


	var config = {
		pkg: grunt.file.readJSON('package.json'),
		clean: {
			prod: ["build"],
			options: {
				force: true
			}
		},

		template: {
			main: {
				options: {
					data: {
						ENV: null,
						C: null,
						MAIN_CSS_FILEPATH: "",
						componentList: null,
						imagesFolder: "/" + _imagesFolder.default,
						imageFiles: _imageFiles
					}
				},
				files: {
					'index.html':             ['build-templates/template-index.html'],
					'core/require.config.js': ['build-templates/template-require.config.js']
				}
			},

			// called at the very end after we've created our custom bundled JS files with the correct md5 hash. This
			// updates the main require.config.js file to point to the newly created bundled files
			recreateRequireConfig: {
				options: {
					data: {
						C: {},
						componentList: ""
					}
				},
				files: {
					'core/require.config.js': ['build-templates/template-require.config.js']
				}
			}
		},

		// populated by _constructPageBundlingData()
		requirejs: { },

		copy: {
			bundledFiles: {
				files: {}
			}
		},

		md5: {
			requireJS: {
				files: _getMD5PathMap(),
				options: {
					encoding: null,
					keepBasename: true,
					keepExtension: true,
					after: function(fileChanges, options) {
						var fileMap = {};         // for the new template-require.config.js file
						var newJSFiles = {};      // for uglification
						var newHBSFiles = {};     // for handlebars precompilation

						for (var i=0; i<fileChanges.length; i++) {
							fileMap[fileChanges[i].oldPath] = fileChanges[i].newPath;

							if (fileChanges[i].newPath.match(/\.js$/)) {
								newJSFiles[fileChanges[i].newPath] = fileChanges[i].newPath;
							} else if (fileChanges[i].newPath.match(/\.hbs$/)) {
								var parts = fileChanges[i].newPath.split("/");

								parts[parts.length-1] = "hbs-" + parts[parts.length-1].replace(/\.hbs$/, ".js");
								var hbsFileNameAndPath = parts.join("/");

								// prefix all handlebar template names with "hbs". This prevents any accidental
								// naming conflicts, should we name a js and an hbs file the same
								newHBSFiles[hbsFileNameAndPath] = fileChanges[i].newPath;

								// now it's a JS file (or will be in a sec) also add this to the newJSFiles for uglification
								newJSFiles[hbsFileNameAndPath] = hbsFileNameAndPath;

								fileMap[fileChanges[i].oldPath] = hbsFileNameAndPath;
							}
						}

						// this is done because it appears the template task's data object is instantiated
						// the moment the FIRST task runs, so we have to manually update it now the md5 filenames
						// are available
						config.template.main.options.data.componentList = _getRequireConfigJSComponentList({ isBundled: true, fileMap: fileMap });
						config.uglify.main.files = newJSFiles;
					}
				}
			},

			// this is populated at the very end of the Stage + Prod build processed to allow us to rename the
			// bundled JS files for their correct file hashes. See _performPageBundling() above for more info.
			bundledFiles: {
				files: {},
				options: {
					encoding: null,
					keepBasename: true,
					keepExtension: true,
					after: function(fileChanges, options) {
						_recreateRequireConfigFileForBundledFiles(fileChanges);
					}
				}
			}
		},

		uglify: {
			coreMinFileBundle: {
				files: {
					'build/core-libs.min.js': [
						"libs/jquery-1.8.2.js",
						"libs/moment.js",
						"libs/underscore.js",
						"libs/backbone.js",
						"libs/backbone-relational.js"
					]
				},
				options: {
					compress: false
				}
			},

			main: {
				files: {}, // populated by md5 task
				options: {
					compress: true
				}
			}
		}
	};

	grunt.initConfig(config);

	// load the required grunt tasks
	grunt.loadNpmTasks('grunt-contrib-clean');
	grunt.loadNpmTasks('grunt-contrib-copy');
	grunt.loadNpmTasks('grunt-md5');
	grunt.loadNpmTasks('grunt-contrib-requirejs');
	grunt.loadNpmTasks('grunt-contrib-uglify');
	grunt.loadNpmTasks('grunt-template');


	// TASKS
	grunt.registerTask('constructPageBundlingData', function() { _constructPageBundlingData(); });

	// uber-verbose. There's probably a nicer way to do this, but hey it's clear
	grunt.registerTask('setBuildEnv_LOCAL', function() { _setBuildEnvironment("LOCAL"); });
	grunt.registerTask('setBuildEnv_PROD',  function() { _setBuildEnvironment("PROD"); });

	grunt.registerTask('default', ['setBuildEnv_LOCAL', 'template:main']);
	grunt.registerTask('prod',    [
		'setBuildEnv_PROD',
		'clean',					 // empty the /build folder
		'md5:requireJS',		 	 // copies all files in _requireJSModulePaths into /build and renames them to include the file's md5 hash
		'template:main',			 // re-creates template-index.html, core/template-require.config.js. core/constants.js with env-specific values
		'uglify:coreMinFileBundle',  // combines the core files specified in template-index.html
		'uglify:main', 			     // minifies all md5-ified requireJS module files

		// BUNDLING! - now bundle up the Core resources, and whatever pages have been specified in bundling.js
		'constructPageBundlingData',
		'requirejs',
		'copy:bundledFiles',
		'md5:bundledFiles'
	]);
};