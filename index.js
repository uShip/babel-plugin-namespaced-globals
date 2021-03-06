'use strict';

var path = require('path');

module.exports = function(babel) {
  var t = babel.types;
  var createdGlobals = {};
  var filenameNoExtCache;

  /**
   * Throws error if filename is unknown.
   * @param {string} filename
   */
  function assertFilenameRequired(filename) {
    if (filename === 'unknown') {
      throw new Error('The babel plugin `globals` requires that filename be given');
    }
  }

/**
 * Throws if a module uses both named and default exports
 * @param  {string} exportType The export type currently being checked
 */
  function assertNoMixedExports(hasNamed, hasDefault) {
    if (hasNamed && hasDefault) {
      throw new Error('Modules-to-global transpilation does not support mixing named and default exports');
    }
  }

  /**
   * Assigns the given declaration to the appropriate global variable.
   * @param {!Object} state
   * @param {!Array} nodes
   * @param {!Declaration} declaration
   */
  function assignDeclarationToGlobal(state, nodes, declaration) {
    var filenameNoExt = getFilenameNoExt(state.file.opts.filename);
    var id = getGlobalIdentifier(state, filenameNoExt, declaration.id.name);
    assignToGlobal(id, nodes, declaration.id);
  }

  /**
   * Assigns the given expression to a global with the given id.
   * @param {string} id
   * @param {!Array} nodes
   * @param {!Expression} expression
   */
  function assignToGlobal(id, nodes, expression) {
    if (createdGlobals.hasOwnProperty(id.name)) return;
    createdGlobals[id.name] = true;
    nodes.push(t.expressionStatement(t.assignmentExpression('=', id, expression)));
  }

  /**
   * Gets the name of the current file without extension.
   * @param {string} filename
   * @return {string}
   */
  function getFilenameNoExt(filename) {
    if (!filenameNoExtCache) {
      assertFilenameRequired(filename);
      filenameNoExtCache = removeExtensions(filename);
    }
    return filenameNoExtCache;
  }

  /**
   * Path to the module, relative to the current working directory.
   * @param {!Object} state This plugin's current state object.
   * @param {string} filePath The path of the module.
   * @return {string} relative path
   */
  function getRootRelativePath(state, filePath) {
    assertFilenameRequired(state.file.opts.filename);
    filePath = path.resolve(path.dirname(state.file.opts.filename), filePath);
    var namespaceRoot = state.opts.namespaceRoot || process.cwd();
    return path.relative(namespaceRoot, filePath);
  }

  /**
   * Builds a string expression of namespaces, using the 
   * current working directory as the root
   * @param {!Object} state This plugin's current state object.
   * @param {string} filePath The path of the module.
   * @param {?string} name The name of the variable being imported or exported from the module.
   * @return {Identifier}
   */
  function buildModuleIdentifier(state, filePath, name) {
    var relativePath = getRootRelativePath(state, filePath);
    var splitPath = relativePath.split(path.sep);

    var idSegments = ['this', state.opts.globalName];
    idSegments.push.apply(idSegments, splitPath);
    if (name) idSegments.push(name);

    return t.identifier(idSegments.join('.'));
  }

  /**
   * Builds an expression for an external module on the global scope.
   * Supports ES6 and CommonJS-style modules by checking for default prop
   * ex. var ExternalModule = this.ExternalModule["default"] || this.ExternalModule;
   * @param  {string} moduleName
   * @param {string} specifierName e.g. `foo` from import { foo } from 'bar';
   * @param {boolean=} isWildcard If the import or export declaration is using a wildcard.
   * @return {LogicalExpression} 
   */
  function buildExternalIdentifier(moduleName, specifierName, isWildcard) {
    var baseExpr = t.memberExpression(
      t.thisExpression(),
      t.identifier(moduleName)
    );

    if (isWildcard) {
      return baseExpr;
    }

    if (specifierName) {
      return t.memberExpression(baseExpr, t.Identifier(specifierName));
    }

    var defaultPropExpr = t.memberExpression(
      baseExpr,
      t.stringLiteral('default'),
      true
    );

    return t.logicalExpression('||', defaultPropExpr, baseExpr);
  }

  /**
   * Appends namespace initialization statements to the 
   * replacement nodes array
   * @param {!Object} state This plugin's current state object.
   * @param {string} filePath The path of the module.
   * @param {[type]} filePath [description]
   */
  function addNamespaceExpressions(state, filePath, nodes) {
    var relativePath = getRootRelativePath(state, filePath);
    var refs = buildNamespaceReferences(relativePath, state.opts.globalName);

    var uncreatedRefs = refs.filter(function(ref) {
      return !createdGlobals.hasOwnProperty(ref.id);
    })

    var statements = uncreatedRefs.map(function(ref) {
      return t.expressionStatement(ref.expr);
    });

    uncreatedRefs.forEach(function(ref) {
      createdGlobals[ref.id] = true;
    });

    nodes.push.apply(nodes, statements);
  }

  /**
   * Walks the module file path, translating each directory level 
   * into a safe namespace initialization expression.
   * @param {string} modulePath The path to the module.
   * @return {Object[]}
   */
  function buildNamespaceReferences(modulePath, globalName) {
    var namespacePaths = modulePath.split(path.sep);
    namespacePaths.pop();

    var base = {
      id: 'this.' + globalName,
      expr: t.memberExpression(
        t.thisExpression(),
        t.identifier(globalName)
      )
    };

    // We need this intermediate step so we still have the previous
    // MemberExpression, which we're using to recursively build up
    // the correct MemberExpression for each part of the namespace path
    var references = namespacePaths.reduce(function(refs, nextPath) {
      var parentRef = refs[refs.length - 1] || base;
      var ref = {
        id: parentRef.id + '.' + nextPath,
        expr: t.memberExpression(parentRef.expr, t.identifier(nextPath))
      };
      return refs.concat(ref);
    }, []);

    // Map the member expression for each namespace path to an
    // assignment expressions, e.g.
    // `this.global.namespacePath = this.global.namespacePath || {};`
    return references.map(function(ref) {
      var assignment = t.assignmentExpression(
        '=',
        ref.expr,
        t.logicalExpression('||', ref.expr, t.objectExpression([]))
      );
      return { id: ref.id, expr: assignment };
    });
  }

  /**
   * Gets the global identifier for the given information.
   * @param {!Object} state This plugin's current state object.
   * @param {string} filePath The path of the module.
   * @param {?string} name The name of the variable being imported or exported from
   *   the module.
   * @param {boolean=} isWildcard If the import or export declaration is using a wildcard.
   * @return {Expression}
   */
  function getGlobalIdentifier(state, filePath, name, isWildcard) {
    var isExternalModule = (state.opts.externals && state.opts.externals[filePath]);

    var globalExpr = (isExternalModule)
      ? buildExternalIdentifier(state.opts.externals[filePath], name, isWildcard)
      : buildModuleIdentifier(state, filePath, name);

    return globalExpr;
  }

  /**
   * Removes all extensions from the given filename.
   * @param {string} filename
   * @return {string}
   */
  function removeExtensions(filename) {
    var extension = path.extname(filename);
    while (extension !== '') {
      filename = path.basename(filename, extension);
      extension = path.extname(filename);
    }
    return filename;
  }

  /**
   * Babylon6 class and function expressions preceded by
   * `export default` are parsed as declarations. Check if the 
   * declaration has an identifier -- if not, create a 
   * declaration with a new local identifier
   * @param  {FunctionDeclaration|ClassDeclaration} declaration
   * @param  {Scope} scope The declaration's scope
   * @return {FunctionDeclaration|ClassDeclaration} Declaration with identifier
   */
  function maybeDeclaration(declaration, scope) {
    if (declaration.id !== null) return declaration;
    
    var id = scope.generateUidIdentifier();
    if (t.isFunctionDeclaration(declaration)) {
      return t.functionDeclaration(
        id,
        declaration.params,
        declaration.body,
        declaration.generator,
        declaration.async
      );
    }

    if (t.isClassDeclaration(declaration)) {
      return t.classDeclaration(
        id,
        declaration.superClass,
        declaration.body,
        declaration.decorators || []
      );
    }
  }

  return {
    visitor: {
      /**
       * Wraps the program body in a closure, protecting local variables.
       * @param {!NodePath} nodePath
       */
      Program: {
        enter: function(nodePath, state) {
          createdGlobals = {};
          filenameNoExtCache = null;

          var body = nodePath.get('body');
          var hasNamedExport = false;
          var hasDefaultExport = false;
          var hasModules = false;

          body.forEach(function(path) {
            if (path.isImportDeclaration()) {
              hasModules = true;
            }
            if (path.isExportNamedDeclaration()) {
              hasNamedExport = true;
              hasModules = true;
            }
            if (path.isExportDefaultDeclaration()) {
              hasDefaultExport = true;
              hasModules = true;
            }
            if (path.isExportAllDeclaration()) {
              hasModules = true;
            }
          });

          assertNoMixedExports(hasNamedExport, hasDefaultExport);


          if (state.opts.transformOnlyModules && !hasModules) {
            return;
          }

          var node = nodePath.node;
          var contents = node.body;
          node.body = [t.expressionStatement(t.callExpression(
            t.memberExpression(
              t.functionExpression(null, [], t.blockStatement(contents)),
              t.identifier('call'),
              false
            ),
            [t.identifier('this')]
          ))];
        }
      },

      /**
       * Replaces import declarations with assignments from global to local variables.
       * @param {!NodePath} nodePath
       * @param {!Object} state
       */
      ImportDeclaration: function(nodePath, state) {
        var replacements = [];
        nodePath.node.specifiers.forEach(function(specifier) {
          var id = getGlobalIdentifier(
            state,
            removeExtensions(nodePath.node.source.value),
            specifier.imported ? specifier.imported.name : null,
            t.isImportNamespaceSpecifier(specifier)
          );
          replacements.push(t.variableDeclaration('var', [
            t.variableDeclarator(specifier.local, id)
          ]));
        });
        nodePath.replaceWithMultiple(replacements);
      },

      /**
       * Removes export all declarations.
       * @param {!NodePath} nodePath
       */
      ExportAllDeclaration: function(nodePath) {
        nodePath.replaceWithMultiple([]);
      },

      /**
       * Replaces default export declarations with assignments to global variables.
       * @param {!NodePath} nodePath
       * @param {!Object} state
       */
      ExportDefaultDeclaration: function(nodePath, state) {
        var node = nodePath.node;
        var fileName = getFilenameNoExt(state.file.opts.filename);
        var replacements = [];
        var identifierToAssign;
        var globalIdentifier;

        // Handles function and class declarations as default exports
        if (t.isFunctionDeclaration(node.declaration) || t.isClassDeclaration(node.declaration)) {
          var declaration = maybeDeclaration(node.declaration, nodePath.scope);
          replacements.push(declaration);
          identifierToAssign = declaration.id;
        } else {
          identifierToAssign = node.declaration;
        }

        addNamespaceExpressions(state, fileName, replacements);
        globalIdentifier = getGlobalIdentifier(state, fileName);
        assignToGlobal(globalIdentifier, replacements, identifierToAssign);

        nodePath.replaceWithMultiple(replacements);
      },

      /**
       * Replaces named export declarations with assignments to global variables.
       * @param {!NodePath} nodePath
       * @param {!Object} state
       */
      ExportNamedDeclaration: function(nodePath, state) {
        var fileName = getFilenameNoExt(state.file.opts.filename);
        var node = nodePath.node;
        var replacements = [];

        // Variable declarations before globals assignments
        if (node.declaration) {
          replacements.push(node.declaration);
        } 

        addNamespaceExpressions(state, fileName, replacements);
        var id = getGlobalIdentifier(state, fileName);
        assignToGlobal(id, replacements, t.objectExpression([]));

        if (node.declaration) {
          if (t.isVariableDeclaration(node.declaration)) {
            node.declaration.declarations.forEach(assignDeclarationToGlobal.bind(null, state, replacements));
          } else {
            assignDeclarationToGlobal(state, replacements, node.declaration);
          }
        } else {
          node.specifiers.forEach(function(specifier) {
            var idToAssign = specifier.exported;
            if (node.source) {
              var specifierName = specifier.local ? specifier.local.name : null;
              idToAssign = getGlobalIdentifier(state, node.source.value, specifierName);
            }

            var id = getGlobalIdentifier(state, fileName, specifier.exported.name);
            assignToGlobal(id, replacements, idToAssign);
          });
        }

        nodePath.replaceWithMultiple(replacements);
      }
    }
  };
};
