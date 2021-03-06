var acorn = require('acorn'),
    assert = require('assert'),
    astannotate = require('astannotate'),
    fs = require('fs'),
    infer = require('tern/lib/infer'),
    path = require('path'),
    scopevisitor = require('scopevisitor'),
    tern = require('tern');

function resolve(pth) { return path.resolve(__dirname, pth); }

function addTestGroup(group, groupPath) {
  describe(group, function() {
    var testInfo = JSON.parse(fs.readFileSync(path.join(groupPath, 'test.json')));
    var ternServer = newTernServer(groupPath, testInfo);
    var cases = fs.readdirSync(groupPath).filter(function(f) { return /\.js$/.test(f); });
    cases.sort();
    ternServer.flush(function(err) {
      if (err) throw err;
    });
    cases.forEach(function(name) {
      ternServer.addFile(path.join(groupPath, name));
    });
    ternServer.flush(function(err) {
      if (err) throw err;
      cases.forEach(function(name) {
        addTestCase(name, path.join(groupPath, name), ternServer);
      });
    });
  });
}

function nodeFilter(_t) {
  return ['Identifier', 'ThisExpression'].indexOf(_t) > -1;
}

function addTestCase(name, casePath, ternServer) {
  var file = ternServer.files.filter(function(f) { return f.name === casePath; })[0];

  if (ternServer._node) ternServer._node.modules[file.name].propagate(ternServer.cx.topScope.defProp('exports'));

  var aliases = {local: {}, nonlocal: {}}, locals = {}, nonlocals = {};
  scopevisitor.inspect(file.name, ternServer.cx.topScope, function(path, prop, local, alias) {
    (local ? locals : nonlocals)[path] = prop;
    if (alias) aliases[local ? 'local' : 'nonlocal'][path] = alias;
  });

  it(name, function(done) {
    // The inline directive DEF causes the test to fail if the specified
    // definition is not found. The directive is of the form /*DEF:<path>:<local>:<alias>*/,
    // where <path> is the def's path, <local> is either 'local' or 'nonlocal' (without quotes),
    // and <alias> is the path of the destination def for this alias def. Options <local> and
    // <alias> are optional.
    var defsV = astannotate.nodeVisitor('def', function(type) { return type == 'Identifier' || type == 'Literal' || type == 'FunctionExpression'; }, function(node, info) {
      info = info.split(':');
      var path = info[0];
      var kind = info[1] || 'nonlocal';
      var defs = ({nonlocal: nonlocals, local: locals})[kind];
      assert(defs[path], 'expected ' + kind + ' path ' + path + ' to be emitted\n' + kind + 's:\n  ' + Object.keys(defs).join('\n  '));
      assert(defs[path].originNode, 'expected ' + kind + ' path ' + path + ' to have non-null originNode\nFull def:\n' + require('util').inspect(defs[path], null, 2));
      assert.equal(defs[path].originNode, node);

      var alias = info[2];
      if (alias) {
        assert(aliases[kind][path], 'expected ' + kind + ' path ' + path + ' to be an alias');
        aliases[kind][path].should.eql(alias);
      } else {
        assert(!aliases[kind][path], 'expected ' + kind + ' path ' + path + ' to not be an alias, but it aliases ' + aliases[kind][path]);
      }
    });
    var typesV = astannotate.nodeVisitor('type', nodeFilter, function(node, wantType) {
      infer.withContext(ternServer.cx, function() {
        var expr = infer.findExpressionAround(file.ast, node.start, node.end);
        var typ = infer.expressionType(expr);

        var start = acorn.getLineInfo(file.text, node.start), end = acorn.getLineInfo(file.text, node.end);
        var loc = 'Expr:    ' + file.text.slice(node.start, node.end) + '\nAt:      ' + file.name + ':' + start.line + ' [' + node.type + ']';

        typ = typ.getType(true) || typ.getFunctionType();
        assert(typ, 'Expr has no type\n' + loc);
        var typStr = typ.toString(1);
        assert(typStr === wantType, 'Expr type does not match expectation\n' + loc + '\nWant: ' + wantType + '\nGot:  ' + typStr);
      });
    });
    var completionsV = astannotate.nodeVisitor('has_props', nodeFilter, function(node, wantProps) {
      wantProps = wantProps.trim().split(',');
      infer.withContext(ternServer.cx, function() {
        var expr = infer.findExpressionAround(file.ast, node.start, node.end);
        var typ = infer.expressionType(expr);
        var allProps = [];

        var start = acorn.getLineInfo(file.text, node.start), end = acorn.getLineInfo(file.text, node.end);
        var loc = 'Expr:    ' + file.text.slice(node.start, node.end) + '\nAt:      ' + file.name + ':' + start.line + ' [' + node.type + ']';

        typ = typ.getType(true) || typ.getFunctionType();
        assert(typ, 'Expr has no type\n' + loc);

        typ.getType().forAllProps(function(prop) {
          allProps.push(prop);
          var i = wantProps.indexOf(prop);
          if (i !== -1) wantProps.splice(i, 1);
        });
        wantProps.sort();
        allProps.sort();

        assert(wantProps.length === 0, 'Expr is missing properties\n' + loc + '\nMissing: ' + wantProps.join(' ') + '\nAll:     ' + allProps.join(' ') + '\nType:    ' + typ.toString());
      });
    });
    astannotate.multi([defsV, typesV, completionsV])(file.text, file.ast);
    done();
  });
}

function runTests() {
  fs.readdirSync(resolve('groups')).forEach(function(group) {
    var groupPath = resolve(path.join('groups', group));
    if (fs.statSync(groupPath).isDirectory()) addTestGroup(group, groupPath);
  });
}

function findFile(file, preferDir, fallbackDir) {
  var local = path.resolve(preferDir, file);
  if (fs.existsSync(local)) return local;
  var shared = path.resolve(fallbackDir, file);
  if (fs.existsSync(shared)) return shared;
}

function newTernServer(dir, testInfo) {
  var defs = (testInfo.defs || []).map(function(file) {
    if (!/\.json$/.test(file)) file += '.json';
    var pth = findFile(file, dir, resolve('node_modules/tern/defs'));
    if (!pth) throw new Error('def not found: ' + file);
    return JSON.parse(fs.readFileSync(pth));
  });
  function loadPlugins(plugins) {
    var options = {};
    for (var plugin in plugins) {
      var val = plugins[plugin];
      if (!val) continue;
      var found = findFile(plugin + ".js", dir, resolve('node_modules/tern/plugin'));
      if (!found) {
        process.stderr.write("Failed to find plugin " + plugin + ".\n");
        continue;
      }
      require(found);
      options[path.basename(plugin)] = val;
    }
    return options;
  }
  var server = new tern.Server({
    debug: true,
    defs: defs,
    getFile: function(name) { return fs.readFileSync(path.resolve(dir, name)); },
    plugins: loadPlugins(testInfo.plugins),
    projectDir: dir,
  });
  if (testInfo.loadEagerly) testInfo.loadEagerly.forEach(function(file) {
    file = file.replace('$(VENDOR)', resolve('vendor'));
    server.addFile(file);
  });
  return server;
}

runTests();
