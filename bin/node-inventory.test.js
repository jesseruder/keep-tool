'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const inventory = require('./node-inventory.js');
const { fakeSpawn } = require('./fixtures/fake-spawn.js');

// Credential-shaped strings planted all over a fake home. None may leave the machine,
// whatever shape they are in: long tokens, and short digit-free words behind every
// way a command line or a config file can carry one.
const SECRETS = {
  claudeCredentials: 'sk-ant-oat01-PLANTEDclaudeCREDENTIAL0000000000',
  npm: 'npm_PLANTEDnpmTOKEN1234567890abcdef',
  netrc: 'PLANTEDnetrcPASSWORD42',
  aws: 'PLANTEDawsSECRETkey0123456789abcdefABCD',
  env: 'PLANTEDdotenvVALUE99',
  mcpUrl: 'PLANTEDurlQUERYtoken77',
  mcpArg: 'PLANTEDargVALUE31',
  mcpEnv: 'PLANTEDmcpENVvalue55',
  mcpHeader: 'PLANTEDheaderBEARER88',
  settingsEnv: 'PLANTEDsettingsENV12',
  codexAuth: 'PLANTEDcodexAUTH65',
  codexToml: 'PLANTEDcodexBEARER43',
  codexHeader: 'PLANTEDcodexHEADER44',
  codexTopKey: 'cormorant',
  piAuth: 'PLANTEDpiAUTH21',
  origin: 'PLANTEDoriginPAT19',
  helper: 'PLANTEDapiKeyHelper',
  hook: 'ghp_PLANTEDhookTOKEN0123456789',
  pathToken: 'PLANTEDpathTOKENsegment42',
  webhook: 'PLANTEDwebhookSECRETvalue',
  webhookTeam: 'T0PLANT77',
  headerEnv: 'PLANTEDotelHEADERvalue',
  envHeaderValue: 'PLANTEDenvHEADERshape',
  jwt: 'eyJhbGciOiJIUzI1NiJ9.eyJQTEFOVEVEand0In0.PLANTEDjwtSIGNATURE9',
  base64url: 'PLANTED-b64url_Zm9vYmFy-QUJDREVGR0g',
  base64slash: 'PLANTED/b64slash+Zm9vYmFyYmF6/QUJDREVG',
  curlUser: 'PLANTEDcurlPASS8',
  mysqlPass: 'PLANTEDmysqlPW3',
  customHeader: 'PLANTEDcustomHDR5',
  shortPositional: 'hunter2x',
  // Short and digit-free: only an allowlist keeps these out.
  keyPrefix: 'letmein',
  envCommand: 'hunter',
  passPair: 'swordfish',
  longEnvFlag: 'kestrel',
  dockerEnv: 'albatross',
  passFlag: 'opensesame',
  pwFlag: 'marmoset',
  splitHeader: 'trustno',
  jsonPrivateKey: 'pelican',
  jsonClientKey: 'heron',
  jsonPat: 'osprey',
  urlPathWord: 'QwErTyUiOp',
  matrixParam: 'gannet',
  // Round three: snake_case credential flags, values glued to any short flag, and
  // names hidden in TOML.
  snakeKey: 'grebe',
  snakeToken: 'plover',
  snakeSecret: 'curlew',
  gluedK: 'godwit',
  gluedP: 'dunlin7',
  gluedX: 'hunterx',
  dashB64: 'QUJDREVGR0hJSktMTU5PUA',
  tomlInString: 'PLANTEDinSTRINGtable',
  tomlTable: 'QwErTyUiOpAsDfGh',
  // Round four: multi-word quoted secrets, an escaped delimiter in a TOML string, and
  // names that say login or bearer.
  quotedPhrase: 'turnstone sanderling whimbrel',
  quotedJson: 'knot stilt',
  quotedFlag: 'avocet ruff',
  tomlEscaped: 'PLANTEDescapedTABLE',
  loginValue: 'bittern',
  bearerValue: 'shoveler',
};

// Round five: a secret inside a quoted span or a command substitution whose own
// prefix is not secret, a quoted value glued to -p, and a quoted tail after a bare
// value. Each case, its planted secret, and what scrub() must print for it.
const NESTED = [
  ['sh -c "mysql --password redknot"', 'redknot', 'sh -c "mysql --password ***"'],
  ['docker run --opts "-a --password dotterel"', 'dotterel', 'docker run --opts "-a --password ***"'],
  ['ssh -o "ProxyCommand x --token lapwing"', 'lapwing', 'ssh -o "ProxyCommand x --token ***"'],
  ['opts="--env API_KEY=killdeer"', 'killdeer', 'opts="--env API_KEY=***"'],
  ['JAVA_OPTS="-Xmx1g -Ddb.password=phalarope"', 'phalarope', 'JAVA_OPTS="-Xmx1g -Ddb.password=***"'],
  ['desc: "export TOKEN=yellowlegs"', 'yellowlegs', 'desc: "export TOKEN=***"'],
  ["args='--db password=willet'", 'willet', "args='--db password=***'"],
  ['mysql -p"oystercatcher"', 'oystercatcher', 'mysql -p"***"'],
  ["mysql -p'stiltbird'", 'stiltbird', "mysql -p'***'"],
  ['--password=ab"cd sanderlingx"', 'sanderlingx', '--password=***"***"'],
  ['echo $(curl -u admin:turnstonex https://x.example.com)', 'turnstonex', 'echo $(curl -u *** https://x.example.com/)'],
  ['run `tool --token whimbrelx`', 'whimbrelx', 'run `tool --token ***`'],
];
for (const [, secret] of NESTED) SECRETS[`nested-${secret}`] = secret;

function write(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content, null, 2));
}

function fakeHome(t) {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'keep-inventory-home-')));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const primary = path.join(home, '.claude');
  const second = path.join(home, '.claude-second');
  write(path.join(primary, '.credentials.json'), { claudeAiOauth: { accessToken: SECRETS.claudeCredentials } });
  write(path.join(home, '.claude.json'), {
    theme: 'dark',
    oauthAccount: { emailAddress: 'owner@example.com', organizationName: 'Example' },
    mcpServers: {
      gateway: { type: 'http', url: `https://mcp.example.com/mcp?token=${SECRETS.mcpUrl}`, headers: { Authorization: `Bearer ${SECRETS.mcpHeader}` } },
      local: { type: 'stdio', command: 'npx', args: ['-y', 'example-mcp', '--api-key', SECRETS.mcpArg], env: { EXAMPLE_TOKEN: SECRETS.mcpEnv } },
      pathy: { type: 'http', url: `https://mcp.example.com/api/mcp/s/${SECRETS.pathToken}/mcp` },
      matrix: { type: 'http', url: `https://mcp.example.com/api;session=${SECRETS.matrixParam}/k/${SECRETS.urlPathWord}` },
      custom: { type: 'stdio', command: 'example-server', args: ['--header', `X-Custom: ${SECRETS.customHeader}`, SECRETS.jwt, SECRETS.base64url, SECRETS.base64slash, SECRETS.shortPositional] },
      envflag: { type: 'stdio', command: 'runner', args: [`--env=API_KEY=${SECRETS.longEnvFlag}`, '--verbose'] },
    },
    projects: {
      [path.join(home, 'src', 'app')]: { mcpServers: { tracker: { type: 'http', url: 'https://tracker.example.com/mcp' } } },
    },
  });
  write(path.join(primary, 'settings.json'), {
    model: 'opus',
    env: {
      EXAMPLE_API_KEY: SECRETS.settingsEnv,
      PLAIN_FLAG: '1',
      OTEL_EXPORTER_OTLP_HEADERS: `Authorization=Basic ${SECRETS.headerEnv}`,
      EXTRA_OPTIONS: `X-Api-Key: ${SECRETS.envHeaderValue}`,
      TOOL_CONFIG: JSON.stringify({ private_key: SECRETS.jsonPrivateKey, clientKey: SECRETS.jsonClientKey, GH_PAT: SECRETS.jsonPat }),
      OTEL_EXPORTER_OTLP_ENDPOINT: `https://otel.example.com/v1/${SECRETS.urlPathWord}`,
      DB_OPTIONS: `password = "${SECRETS.quotedPhrase}" timeout = 5`,
      JSON_OPTIONS: `{"secret" : "${SECRETS.quotedJson}", "theme": "dark"}`,
      TOOL_ARGS: `--password '${SECRETS.quotedFlag}' --port 8080`,
      SERVICE_LOGIN: SECRETS.loginValue,
      API_BEARER: SECRETS.bearerValue,
      ...Object.fromEntries(NESTED.map(([text], index) => [`NESTED_${index}`, text])),
    },
    apiKeyHelper: `echo ${SECRETS.helper}`,
    someTool: { private_key: SECRETS.jsonPrivateKey, clientKey: SECRETS.jsonClientKey, GH_PAT: SECRETS.jsonPat },
    statusLine: { type: 'command', command: `${home}/.claude/statusline.sh --pass ${SECRETS.passFlag}` },
    hooks: {
      Stop: [{ hooks: [{ type: 'command', command: `${home}/bin/stop-hook --token ${SECRETS.hook}` }] }],
      Notification: [{ hooks: [
        { type: 'command', command: `curl -u admin:${SECRETS.curlUser} -H "X-Custom: ${SECRETS.splitHeader} value" https://hooks.example.com/services/${SECRETS.webhookTeam}/B0PLANT88/${SECRETS.webhook}` },
        { type: 'command', command: `mysql -p${SECRETS.mysqlPass} -e status ${SECRETS.jwt}` },
        { type: 'http', url: `https://hooks.example.com/services/${SECRETS.webhookTeam}/B0PLANT88/${SECRETS.webhook}` },
      ] }],
      SessionStart: [{ hooks: [
        { type: 'command', command: `API_TOKEN=${SECRETS.keyPrefix} node x.js` },
        { type: 'command', command: `env API_KEY=${SECRETS.envCommand} node x` },
        { type: 'command', command: `tool pass=${SECRETS.passPair}` },
        { type: 'command', command: `docker run -e DB_PASSWORD=${SECRETS.dockerEnv} image` },
        { type: 'command', command: `tool --pw ${SECRETS.pwFlag} --pass ${SECRETS.passFlag}` },
        { type: 'command', command: `tool --api_key ${SECRETS.snakeKey} --access_token ${SECRETS.snakeToken} --client_secret ${SECRETS.snakeSecret}` },
        { type: 'command', command: `tool -k${SECRETS.gluedK} -P${SECRETS.gluedP} -x${SECRETS.gluedX} -${SECRETS.dashB64} -la` },
      ] }],
    },
    permissions: { allow: ['Bash(ls:*)'] },
  });
  write(path.join(primary, 'CLAUDE.md'), '# global\n');
  write(path.join(primary, 'skills', 'alpha', 'SKILL.md'), '---\nname: alpha\n---\n');
  write(path.join(primary, 'projects', '-src-app', 'memory', 'MEMORY.md'), '- note\n');
  write(path.join(second, '.claude.json'), { mcpServers: {} });
  write(path.join(second, 'CLAUDE.md'), '# global, older\n');
  write(path.join(home, '.npmrc'), `//registry.npmjs.org/:_authToken=${SECRETS.npm}\n`);
  write(path.join(home, '.netrc'), `machine example.com login me password ${SECRETS.netrc}\n`);
  write(path.join(home, '.aws', 'credentials'), `[default]\naws_secret_access_key = ${SECRETS.aws}\n`);
  write(path.join(home, '.codex', 'auth.json'), { tokens: { access_token: SECRETS.codexAuth } });
  write(path.join(home, '.codex', 'config.toml'), [
    'model = "gpt-test"',
    'model_reasoning_effort = "high"',
    `openai_api_key = "${SECRETS.codexTopKey}"`,
    // The nested cases as top-level Codex config values: a TOML literal string when
    // the case has no single quote, a basic string with its quotes escaped otherwise.
    ...NESTED.map(([text], index) => `nested_${index} = ${text.includes('\'') ? `"${text.replace(/"/g, '\\"')}"` : `'${text}'`}`),
    'notes = """',
    `["${SECRETS.tomlInString}"]`,
    '"""',
    'doc = """ first \\""" is escaped, the string goes on',
    `["${SECRETS.tomlEscaped}"]`,
    '"""',
    `["${SECRETS.tomlTable}"]`,
    'x = 1',
    '[tui]',
    'status_line = ["model", "context"]',
    'notifications = true',
    '[mcp_servers.docs]',
    'url = "https://docs.example.com/mcp"',
    `bearer_token = "${SECRETS.codexToml}"`,
    '[mcp_servers.docs.http_headers]',
    `Authorization = "Bearer ${SECRETS.codexHeader}"`,
    '[profiles.fast]',
    'model = "gpt-fast"',
  ].join('\n'));
  write(path.join(home, '.pi', 'agent', 'auth.json'), { key: SECRETS.piAuth });
  write(path.join(home, 'bin', 'tool.sh'), `#!/bin/sh\nexport TOKEN=${SECRETS.env}\n`);
  const repo = path.join(home, 'src', 'app');
  write(path.join(repo, '.env'), `SECRET=${SECRETS.env}\n`);
  write(path.join(repo, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  return { home, primary, second, repo };
}

// No subprocess at all: git answers here the way a checkout would.
function gitAnswers(origin) {
  return fakeSpawn((file, args) => {
    if (args[0] === '-C' && args[2] === 'status') return '# branch.oid 0123456789abcdef\n# branch.head main\n? stray\n';
    if (args[0] === '-C' && args[2] === 'remote') return `${origin}\n`;
    return '';
  });
}

function options(fixture, extra = {}) {
  const spawner = gitAnswers(`https://someone:${SECRETS.origin}@github.com/example/app.git`);
  return {
    spawner,
    value: {
      home: fixture.home,
      claudeDirs: [fixture.primary, fixture.second],
      codexDirs: [path.join(fixture.home, '.codex')],
      repoRoots: [path.join(fixture.home, 'src')],
      keepDir: path.join(fixture.home, 'keep'),
      shellEnv: { PATH: '/nonexistent-bin', JAVA_HOME: '/opt/java' },
      tools: [],
      logins: false,
      spawn: spawner.spawn,
      salt: '0123456789abcdef0123456789abcdef',
      ...extra,
    },
  };
}

const byKey = (entries) => new Map(entries.map((entry) => [`${entry.section} ${entry.key}`, entry.value]));

test('no planted credential ever appears in the inventory', async (t) => {
  const fixture = fakeHome(t);
  const entries = await inventory.collectInventory(options(fixture).value);
  const text = inventory.toLines(entries).join('\n');
  for (const [name, secret] of Object.entries(SECRETS)) {
    assert.ok(!text.includes(secret), `${name} leaked: ${text.split('\n').find((line) => line.includes(secret))}`);
  }
  // What is there instead: presence, names, allowlisted words and hashes.
  const lines = byKey(entries);
  const sha = '[0-9a-f]{12}';
  assert.equal(lines.get('claude:~/.claude credentials-file'), 'present');
  assert.equal(lines.get('codex:~/.codex auth.json'), 'present');
  assert.equal(lines.get('pi auth.json'), 'present');
  assert.equal(lines.get('misc .netrc'), 'present');
  assert.equal(lines.get('misc .aws/credentials'), 'present');
  assert.match(lines.get('dotfile .npmrc'), /^sha=[0-9a-f]{12} bytes=\d+$/);
  assert.equal(lines.get('claude:~/.claude settings.json:env:EXAMPLE_API_KEY'), 'set');
  assert.equal(lines.get('claude:~/.claude settings.json:env:PLAIN_FLAG'), '1');
  assert.equal(lines.get('claude:~/.claude settings.json:env:OTEL_EXPORTER_OTLP_HEADERS'), 'set');
  assert.equal(lines.get('claude:~/.claude settings.json:env:EXTRA_OPTIONS'), 'X-Api-Key: ***');
  assert.equal(lines.get('claude:~/.claude settings.json:env:TOOL_CONFIG'), '{"private_key":"***","clientKey":"***","GH_PAT":"***"}');
  assert.match(lines.get('claude:~/.claude settings.json:env:OTEL_EXPORTER_OTLP_ENDPOINT'), /^https:\/\/otel\.example\.com\/v1\/\*[0-9a-f]{8}$/);
  assert.equal(lines.get('claude:~/.claude settings.json:apiKeyHelper'), 'set');
  assert.match(lines.get('claude:~/.claude settings.json:someTool'), /^keys=\[GH_PAT,clientKey,private_key\] sha=/);
  assert.match(lines.get('claude:~/.claude settings.json:statusLine'), new RegExp(`^command:~/\\.claude/statusline\\.sh --pass \\*\\*\\* sha=${sha}$`));
  assert.equal(lines.get('claude:~/.claude mcp:user:gateway'), 'http https://mcp.example.com/mcp?token=*** headers=[Authorization]');
  assert.match(lines.get('claude:~/.claude mcp:user:local'), new RegExp(`^stdio npx -y example-mcp --api-key \\*\\*\\* sha=${sha} env=\\[EXAMPLE_TOKEN\\]$`));
  assert.match(lines.get('claude:~/.claude mcp:user:pathy'), /^http https:\/\/mcp\.example\.com\/api\/mcp\/s\/\*[0-9a-f]{8}\/mcp$/);
  assert.match(lines.get('claude:~/.claude mcp:user:matrix'), /^http https:\/\/mcp\.example\.com\/api;\*\*\*\/k\/\*[0-9a-f]{8}$/);
  assert.match(lines.get('claude:~/.claude mcp:user:custom'), new RegExp(`^stdio example-server --header \\*\\*\\* \\*\\*\\* \\*\\*\\* \\*\\*\\* \\*\\*\\* sha=${sha}$`));
  assert.match(lines.get('claude:~/.claude mcp:user:envflag'), new RegExp(`^stdio runner --env=\\*\\*\\* --verbose sha=${sha}$`));
  assert.match(lines.get('claude:~/.claude settings.json:hooks:Stop'), new RegExp(`^command:~/bin/stop-hook --token \\*\\*\\* sha=${sha}$`));
  assert.match(lines.get('claude:~/.claude settings.json:hooks:Notification'),
    /^command:curl -u \*\*\* -H \*\*\* https:\/\/hooks\.example\.com\/services\/\*[0-9a-f]{8}\/\*[0-9a-f]{8}\/\*[0-9a-f]{8} sha=/);
  const session = lines.get('claude:~/.claude settings.json:hooks:SessionStart').split(' || ');
  assert.match(session[0], new RegExp(`^command:\\*\\*\\* node x\\.js sha=${sha}$`));
  assert.match(session[1], new RegExp(`^command:env \\*\\*\\* node x sha=${sha}$`));
  assert.match(session[2], new RegExp(`^command:tool \\*\\*\\* sha=${sha}$`));
  assert.match(session[3], new RegExp(`^command:docker run -e \\*\\*\\* image sha=${sha}$`));
  assert.match(session[4], new RegExp(`^command:tool --pw \\*\\*\\* --pass \\*\\*\\* sha=${sha}$`));
  assert.match(session[5], new RegExp(`^command:tool --api_key \\*\\*\\* --access_token \\*\\*\\* --client_secret \\*\\*\\* sha=${sha}$`));
  assert.match(session[6], new RegExp(`^command:tool -k\\*\\*\\* -P\\*\\*\\* -x\\*\\*\\* -Q\\*\\*\\* -la sha=${sha}$`));
  assert.equal(lines.get('codex:~/.codex config:notes'), '(multi-line)');
  assert.equal(lines.get('codex:~/.codex config:doc'), '(multi-line)');
  assert.equal(lines.get('claude:~/.claude settings.json:env:DB_OPTIONS'), 'password = "***" timeout = 5');
  assert.equal(lines.get('claude:~/.claude settings.json:env:JSON_OPTIONS'), '{"secret" : "***", "theme": "dark"}');
  assert.equal(lines.get('claude:~/.claude settings.json:env:TOOL_ARGS'), '--password \'***\' --port 8080');
  assert.equal(lines.get('claude:~/.claude settings.json:env:SERVICE_LOGIN'), 'set');
  assert.equal(lines.get('claude:~/.claude settings.json:env:API_BEARER'), 'set');
  assert.ok([...lines.keys()].some((key) => /^codex:~\/\.codex table:\*[0-9a-f]{8}$/.test(key)), 'a random-looking table name is a hash marker');
  assert.match(lines.get('repo ~/src/app'), /^main@0123456 origin=https:\/\/github.com\/example\/app.git dirty=1 env=\[\.env\]/);
  assert.equal(lines.get('codex:~/.codex config:model'), '"gpt-test"', 'a profile\'s model is not the top-level one');
  assert.equal(lines.get('codex:~/.codex config:openai_api_key'), 'set');
  assert.match(lines.get('codex:~/.codex table:tui'), /^keys=\[notifications,status_line\] sha=/);
  assert.match(lines.get('codex:~/.codex table:mcp_servers'), /^keys=\[docs\] sha=/);
  assert.match(lines.get('codex:~/.codex table:profiles'), /^keys=\[fast\] sha=/);
});

test('the inventory reads each config dir, a project-scope MCP server, and is the same twice', async (t) => {
  const fixture = fakeHome(t);
  const first = await inventory.collectInventory(options(fixture).value);
  const second = await inventory.collectInventory(options(fixture).value);
  assert.deepEqual(first, second, 'two runs over the same machine agree line for line');
  assert.deepEqual(first.map((entry) => `${entry.section}\t${entry.key}`), first.map((entry) => `${entry.section}\t${entry.key}`).slice().sort(),
    'sorted by section then key');
  const get = (section, key) => (first.find((entry) => entry.section === section && entry.key === key) || {}).value;
  assert.equal(get('claude:~/.claude', 'mcp:project:~/src/app:tracker'), 'http https://tracker.example.com/mcp');
  assert.equal(get('claude:~/.claude', 'login'), 'owner@example.com org=Example');
  assert.match(get('claude:~/.claude', 'skills/alpha'), /^dir sha=[0-9a-f]{12} bytes=\d+$/);
  assert.match(get('claude:~/.claude', 'memory:-src-app'), /^1 files MEMORY.md=sha=/);
  assert.notEqual(get('claude:~/.claude', 'CLAUDE.md'), get('claude:~/.claude-second', 'CLAUDE.md'));
  assert.equal(get('claude:~/.claude-second', 'skills'), 'absent');
  assert.equal(get('claude:~/.claude-second', 'credentials-file'), 'absent');
  assert.equal(get('env', 'JAVA_HOME'), '/opt/java');
  assert.equal(get('inventory', 'partial'), undefined);
});

test('a read that fails for another reason than a missing file is unread, never absent', async (t) => {
  const fixture = fakeHome(t);
  const fsp = require('node:fs/promises');
  const denied = (target) => (p, ...rest) => (String(p).includes(`${path.sep}.claude-second`)
    ? Promise.reject(Object.assign(new Error('denied'), { code: 'EACCES' })) : target(p, ...rest));
  const fake = { ...fsp, stat: denied(fsp.stat), lstat: denied(fsp.lstat), readdir: denied(fsp.readdir) };
  const lines = byKey(await inventory.collectInventory({ ...options(fixture).value, fsp: fake }));
  assert.equal(lines.get('claude:~/.claude-second CLAUDE.md'), 'unread (EACCES)');
  assert.equal(lines.get('claude:~/.claude-second claude.json'), 'unread (EACCES)');
  assert.equal(lines.get('claude:~/.claude-second skills'), 'unread (EACCES)');
  assert.equal(lines.get('claude:~/.claude-second credentials-file'), 'unread (EACCES)');
});

test('a collection past its deadline answers with what it has, starts nothing after it, and kills what runs', async (t) => {
  const fixture = fakeHome(t);
  for (const name of ['one', 'two', 'three', 'four', 'five']) fs.mkdirSync(path.join(fixture.home, 'src', name, '.git'), { recursive: true });
  const hung = fakeSpawn(() => 'hang');
  const collection = inventory.startInventory({ ...options(fixture).value, spawn: hung.spawn, deadlineMs: 150, concurrency: 1, subprocessTimeoutMs: 60e3 });
  const entries = await collection.result;
  const partial = inventory.partialOf(entries);
  assert.equal(partial, 'repo', 'named as the report section, not the collection group');
  assert.ok(entries.some((entry) => entry.section === 'claude:~/.claude'), 'what finished is kept');
  const atDeadline = hung.calls.length;
  assert.equal(atDeadline, 1, 'one at a time, and the rest were still queued');
  await collection.idle;
  assert.equal(hung.kills, 1, 'the running one was killed at the deadline');
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(hung.calls.length, atDeadline, 'nothing queued started after the deadline');
  assert.deepEqual(collection.stats(), { spawned: 1, active: 0, fsActive: 0 });
});

test('a subprocess timeout holds its slot until the child has closed, and reports timeout', async (t) => {
  const fixture = fakeHome(t);
  // The status answers; the remote lookup hangs past its timeout, and its kill does
  // not land until the test lets it.
  const held = fakeSpawn((file, args) => (args[2] === 'status' ? '# branch.head main\n' : 'hang'), { holdKills: true });
  const collection = inventory.startInventory({ ...options(fixture).value, spawn: held.spawn, subprocessTimeoutMs: 50, deadlineMs: 10e3 });
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(held.kills, 1, 'the timeout asked for the kill');
  assert.equal(collection.stats().active, 1, 'the slot is still held while the child has not closed');
  held.landKills();
  const lines = byKey(await collection.result);
  assert.match(lines.get('repo ~/src/app'), /^main@\? origin=none /);
  assert.equal(collection.stats().active, 0);
});

test('a timed-out subprocess is killed with everything in its process group', async (t) => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'keep-inventory-group-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  // A "login shell" that starts a child of its own and then waits, as an rc file
  // that launches an agent might.
  const shell = path.join(dir, 'fake-login-shell');
  fs.writeFileSync(shell, `#!/bin/sh\necho $$ > "${dir}/shell.pid"\nsleep 300 &\necho $! > "${dir}/child.pid"\nwait\n`, { mode: 0o755 });
  const started = Date.now();
  // Long enough for the script to write both pids under a loaded test run.
  const entries = await inventory.collectInventory({
    home: dir, shell, shellTimeoutMs: 2000, deadlineMs: 10e3, tools: [], logins: false,
    claudeDirs: [path.join(dir, '.claude')], codexDirs: [path.join(dir, '.codex')], repoRoots: [path.join(dir, 'none')],
  });
  assert.ok(Date.now() - started < 5000, 'answered once the probe timed out');
  assert.equal(byKey(entries).get('env source'), 'process (timeout)');
  const pids = ['shell.pid', 'child.pid'].map((name) => Number(fs.readFileSync(path.join(dir, name), 'utf8').trim()));
  const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  const until = Date.now() + 1000;
  while (pids.some(alive) && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 25));
  assert.deepEqual(pids.map(alive), [false, false], 'the shell and the child it started are both gone');
});

test('the repo walk stops at its cap and says so', async (t) => {
  const fixture = fakeHome(t);
  for (const name of ['one', 'two', 'three']) fs.mkdirSync(path.join(fixture.home, 'src', name, '.git'), { recursive: true });
  const entries = await inventory.collectInventory({ ...options(fixture).value, maxRepos: 2 });
  const repos = entries.filter((entry) => entry.section === 'repo' && entry.key.startsWith('~/'));
  assert.equal(repos.length, 2);
  assert.equal(entries.find((entry) => entry.key === '(capped)').value, 'repos capped at 2');
});

test('a file one side could not read makes its rows on the other side unread, not different', async (t) => {
  const fixture = fakeHome(t);
  fs.writeFileSync(path.join(fixture.second, '.claude.json'), JSON.stringify({ pad: 'x'.repeat((1 << 20) + 10) }));
  const entries = await inventory.collectInventory(options(fixture).value);
  const row = entries.find((entry) => entry.section === 'claude:~/.claude-second' && entry.key === 'claude.json');
  assert.match(row.value, /^too large \(bytes=\d+\)$/);
  const S = 'claude:~/.claude-second';
  const a = [
    { section: S, key: 'mcp:user:x', value: 'http https://x' },
    { section: S, key: 'settings.json:model', value: '"opus"' },
    { section: S, key: 'settings.json:hooks:Stop', value: 'command:x sha=1' },
    { section: S, key: 'CLAUDE.md', value: 'sha=1' },
  ];
  const b = [
    { section: S, key: 'claude.json', value: row.value },
    { section: S, key: 'settings.json', value: 'unparseable' },
    { section: S, key: 'CLAUDE.md', value: 'sha=2' },
  ];
  const [section] = inventory.compareInventories(a, b);
  const noise = Object.fromEntries(section.onlyA.map((item) => [item.key, item.noise]));
  assert.deepEqual(noise, {
    'mcp:user:x': 'rows of a file one side could not read',
    'settings.json:hooks:Stop': 'rows of a file one side could not read',
    'settings.json:model': 'rows of a file one side could not read',
  });
  assert.equal(section.differ[0].noise, null, 'an ordinary difference is still one');
});

test('a Codex config table on one side only is its own row', () => {
  const base = ['model = "gpt-test"', '[mcp_servers.docs]', 'url = "https://docs.example.com/mcp"'];
  const withTui = [...base, '[tui]', 'status_line = ["model"]', 'terminal_title = true', 'notifications = true'];
  const rows = (lines) => inventory.codexConfigRows(lines.join('\n')).map(([key, value]) => ({ section: 'codex:~/.codex', key, value }));
  const [section] = inventory.compareInventories(rows(withTui), rows(base));
  assert.deepEqual(section.onlyA.map((item) => [item.key, item.noise]), [['table:tui', null]]);
  assert.match(section.onlyA[0].value, /^keys=\[notifications,status_line,terminal_title\] sha=[0-9a-f]{12}$/);
  assert.equal(section.same, 2, 'the model and the mcp_servers table agree');
});

test('the report warns first when either side was cut short, and those sections are summarised', () => {
  const a = [{ section: 'login', key: 'gh', value: 'ok' }, { section: 'pi', key: 'AGENTS.md', value: 'sha=1' }];
  const b = [{ section: 'inventory', key: 'partial', value: 'login,repo' }, { section: 'pi', key: 'AGENTS.md', value: 'sha=2' }];
  const sections = inventory.compareInventories(a, b);
  assert.equal(sections.find((row) => row.section === 'login').onlyA[0].noise, 'rows in a section cut short at the deadline');
  const report = inventory.renderComparison(sections, { nameA: 'main', nameB: 'mini', partial: { a: null, b: 'login,repo' } });
  const lines = report.split('\n');
  assert.match(lines[0], /^warning: mini's inventory hit its deadline; .*: login,repo$/);
  assert.match(lines[1], /^main vs mini: /);
  assert.doesNotMatch(report, /gh = ok/);
  assert.match(report, /pi[\s\S]*main {2}sha=1/);
  // A row both sides reported is a real difference even in a cut-short section.
  const both = inventory.compareInventories(
    [{ section: 'login', key: 'gh', value: 'one' }],
    [{ section: 'inventory', key: 'partial', value: 'login' }, { section: 'login', key: 'gh', value: 'two' }],
  );
  assert.equal(both.find((row) => row.section === 'login').differ[0].noise, null);
});

test('hashes are salted: one salt compares, another does not, and none is unsalted', async (t) => {
  const fixture = fakeHome(t);
  const salt = 'fedcba9876543210fedcba9876543210';
  const get = (entries) => byKey(entries).get('claude:~/.claude CLAUDE.md');
  const one = get(await inventory.collectInventory(options(fixture, { salt }).value));
  const again = get(await inventory.collectInventory(options(fixture, { salt }).value));
  const other = get(await inventory.collectInventory(options(fixture, { salt: 'aa'.repeat(16) }).value));
  const none = get(await inventory.collectInventory(options(fixture, { salt: 'not-hex' }).value));
  assert.equal(one, again);
  assert.notEqual(one, other);
  const plain = require('node:crypto').createHash('sha256').update('# global\n').digest('hex').slice(0, 12);
  for (const value of [one, other, none]) assert.ok(!value.includes(plain), 'never the unsalted hash');
});

test('a Codex config too large to itemise says so, and its rows on the other side are summarised', async (t) => {
  const fixture = fakeHome(t);
  const big = path.join(fixture.home, '.codex-big');
  write(path.join(big, 'config.toml'), `model = "x"\n# ${'x'.repeat((1 << 20) + 10)}\n`);
  const lines = byKey(await inventory.collectInventory(options(fixture, { codexDirs: [big] }).value));
  assert.match(lines.get('codex:~/.codex-big config.toml'), /^too large \(bytes=\d+\)$/);
  const [section] = inventory.compareInventories(
    [{ section: 'codex:~/.codex', key: 'table:tui', value: 'keys=[a] sha=1' }],
    [{ section: 'codex:~/.codex', key: 'config.toml', value: 'too large (bytes=2000000)' }],
  );
  assert.equal(section.onlyA[0].noise, 'rows of a file one side could not read');
});

test('resolving the requested directories is bounded per directory and in total', async (t) => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'keep-inventory-bounds-')));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  fs.mkdirSync(path.join(home, '.claude'));
  fs.mkdirSync(path.join(home, 'hung'));
  const fsp = require('node:fs/promises');
  const asked = [];
  // One directory on a mount that never answers.
  const realpath = (value) => {
    asked.push(value);
    return value.endsWith(`${path.sep}hung`) ? new Promise(() => {}) : fsp.realpath(value);
  };
  const stuck = (error) => error.code === 'scope-timeout' && /inventory-stuck: filesystem/.test(error.message);
  assert.deepEqual(await inventory.requestOptions({ claudeDirs: ['~/.claude'], salt: 'ab'.repeat(8) }, home, { realpath, timeoutMs: 50 }),
    { claudeDirs: [path.join(home, '.claude')], salt: 'ab'.repeat(8) });
  assert.deepEqual(await inventory.requestOptions({ salt: 'xyz' }, home), {}, 'a malformed salt is dropped');
  // A single hung realpath fails the whole answer, and nothing after it starts.
  asked.length = 0;
  await assert.rejects(inventory.requestOptions({ claudeDirs: ['~/hung', '~/.claude'], codexDirs: ['~/.claude'] }, home, { realpath, timeoutMs: 50 }), stuck);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.deepEqual(asked, [home, path.join(home, 'hung')], 'no realpath after the one that hung');
  assert.equal(inventory.realpathsInFlight(realpath), 1, 'the hung call is still counted');
  // The home's own realpath hanging fails it too, and so does the total bound.
  const allHung = () => new Promise(() => {});
  await assert.rejects(inventory.requestOptions({}, home, { realpath: allHung, timeoutMs: 50 }), stuck);
  await assert.rejects(inventory.requestOptions({ claudeDirs: ['~/hung'] }, home, { realpath: allHung, timeoutMs: 10e3, totalMs: 50 }), stuck);
  assert.equal(inventory.realpathsInFlight(), 0, 'the real realpath is not counted with the fakes');
});

test('a remote caller may only point the collection at directories under the home, symlinks resolved', async (t) => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'keep-inventory-scope-')));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  fs.mkdirSync(path.join(home, '.claude'));
  fs.mkdirSync(path.join(home, '.claude-b'));
  fs.symlinkSync('/', path.join(home, 'escape'));
  fs.symlinkSync(path.join(home, '.claude-b'), path.join(home, 'inside'));
  assert.deepEqual(await inventory.requestOptions({
    claudeDirs: ['~/.claude', `${home}/.claude-b`, '/etc', '~/../other', 'relative', 7, '~/.claude', '~/escape', '~/escape/etc', '~/inside', '~/missing'],
    codexDirs: 'not-a-list',
    repoRoots: ['~'],
    home: '/elsewhere',
  }, home), { claudeDirs: [path.join(home, '.claude'), path.join(home, '.claude-b'), path.join(home, 'inside')], repoRoots: [home] });
  assert.deepEqual(await inventory.requestOptions({}, home), {});
});

test('a secret inside a quoted span or command substitution is masked, whatever came before it', async (t) => {
  // Directly: the exact round-four output for each case, and the secret nowhere.
  for (const [text, secret, expected] of NESTED) {
    const out = inventory.scrub(text);
    assert.equal(out, expected, text);
    assert.ok(!out.includes(secret));
  }
  // Through a settings env value and a Codex config value.
  const fixture = fakeHome(t);
  const lines = byKey(await inventory.collectInventory(options(fixture).value));
  NESTED.forEach(([, secret, expected], index) => {
    assert.equal(lines.get(`claude:~/.claude settings.json:env:NESTED_${index}`), expected);
    const config = lines.get(`codex:~/.codex config:nested_${index}`);
    assert.ok(config && !config.includes(secret), `config value ${index}: ${config}`);
  });
  // Nested spans are followed to a bounded depth, and a long adversarial text stays cheap.
  assert.equal(inventory.scrub('a "b \'c `d $(e --token f)`\'"'), 'a "b \'c `d $(e --token ***)`\'"');
  const started = Date.now();
  for (const text of ['A-'.repeat(2048), '"'.repeat(4096), '$('.repeat(2000), ' '.repeat(4000) + 'x']) inventory.scrub(text);
  assert.ok(Date.now() - started < 500, 'adversarial inputs stay cheap');
});

test('scrub, safeUrl and safeCommand', () => {
  assert.equal(inventory.scrub('node ~/bin/keep.js hook stop'), 'node ~/bin/keep.js hook stop');
  assert.equal(inventory.scrub('curl -H "Authorization: Bearer abc.def"'), 'curl -H "***"');
  assert.equal(inventory.scrub('x=1 secret="a \\" b c" y=2'), 'x=1 secret="***" y=2', 'an escaped quote does not end the value');
  const long = `${'a'.repeat(30000)} ${' '.repeat(30000)}#`;
  const started = Date.now();
  inventory.scrub(long);
  inventory.codexConfigRows(`k = 1${' '.repeat(30000)}x`);
  assert.ok(Date.now() - started < 500, 'long input costs little');
  assert.equal(inventory.scrub('Authorization: Bearer abc.def'), 'Authorization: ***');
  assert.equal(inventory.scrub('curl -u admin:pass https://x.example.com'), 'curl -u *** https://x.example.com/');
  assert.equal(inventory.scrub('mysql -phunter2 db'), 'mysql -p*** db');
  assert.equal(inventory.scrub('psql -h db.local -U reader -P pager=off'), 'psql -h db.local -U reader -P pager=off');
  assert.equal(inventory.scrub('pass=letmein clientKey: heron'), 'pass=*** clientKey: ***');
  assert.equal(inventory.scrub('token is eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJlMTIz ok'), 'token is *** ok');
  assert.equal(inventory.scrub('/Library/Java/JavaVirtualMachines/zulu-17.jdk/Contents/Home'), '/Library/Java/JavaVirtualMachines/zulu-17.jdk/Contents/Home');
  assert.equal(inventory.scrub('see https://user:pw@host.example.com/x?key=1&v=2 now'), 'see https://host.example.com/x?key=***&v=*** now');
  assert.equal(inventory.scrub('uses ghp_abcdefghij0123456789'), 'uses ***');
  assert.equal(inventory.safeUrl('https://github.com/example/app.git'), 'https://github.com/example/app.git');
  assert.equal(inventory.safeUrl('git@github.com:example/app.git'), 'git@github.com:example/app.git');
  assert.match(inventory.safeUrl('https://hooks.example.com/services/T0ABCDEF1/B0ABCDEF2/abcdefghijklmnopqrstuvwx'),
    /^https:\/\/hooks\.example\.com\/services\/\*[0-9a-f]{8}\/\*[0-9a-f]{8}\/\*[0-9a-f]{8}$/);
  assert.deepEqual(inventory.tokenize(`a -H "X-Api-Key: letmein" 'b c'`), ['a', '-H', 'X-Api-Key: letmein', 'b c']);
  assert.match(inventory.safeCommand(['node', '--token=abc', '--port', '8080', '-y', 'pkg']), /^node \*\*\* --port 8080 -y pkg sha=[0-9a-f]{12}$/);
  assert.match(inventory.safeCommand('curl -H "X-Api-Key: letmein" https://x.example.com'), /^curl -H \*\*\* https:\/\/x\.example\.com\/ sha=/);
  assert.match(inventory.safeCommand('psql -h db -U reader -P pager'), /^psql -h db -U reader -P pager sha=/, 'psql\'s -h, -U and -P are not credentials');
  assert.notEqual(inventory.safeCommand('run --pw one'), inventory.safeCommand('run --pw two'), 'the hash still tells two lines apart');
});

const A = [
  { section: 'claude:~/.claude', key: 'skills/alpha', value: 'dir sha=aaa' },
  { section: 'claude:~/.claude', key: 'skills/beta', value: 'dir sha=bbb' },
  { section: 'claude:~/.claude', key: 'memory:-proj-one', value: '1 files' },
  { section: 'claude:~/.claude', key: 'CLAUDE.md', value: 'sha=111' },
  { section: 'claude:~/.claude', key: 'settings.json:model', value: '"opus"' },
  { section: 'repo', key: '~/src/app', value: 'main@1111111' },
  { section: 'repo', key: '~/wt/app/one', value: 'wt/one@2222222' },
  { section: 'tool', key: 'gh', value: 'present' },
  { section: 'tool', key: 'brew', value: 'present' },
  { section: 'tool-path', key: 'gh', value: '/opt/homebrew/bin/gh' },
  { section: 'pi', key: 'AGENTS.md', value: 'sha=999' },
];
const B = [
  { section: 'claude:~/.claude', key: 'skills/alpha', value: 'dir sha=aaa' },
  { section: 'claude:~/.claude', key: 'skills/gamma', value: 'dir sha=ccc' },
  { section: 'claude:~/.claude', key: 'CLAUDE.md', value: 'sha=222' },
  { section: 'claude:~/.claude', key: 'settings.json:model', value: '"opus"' },
  { section: 'repo', key: '~/src/app', value: 'main@1111111' },
  { section: 'tool', key: 'gh', value: 'absent' },
  { section: 'tool', key: 'brew', value: 'absent' },
  { section: 'tool-path', key: 'gh', value: 'absent' },
  { section: 'pi', key: 'AGENTS.md', value: 'sha=999' },
];

test('the comparer sorts each key into only-on-A, only-on-B, differ or same, with its noise class', () => {
  const sections = inventory.compareInventories(A, B);
  const claude = sections.find((row) => row.section === 'claude:~/.claude');
  assert.equal(claude.same, 2);
  assert.deepEqual(claude.onlyA.map((item) => [item.key, item.noise]), [['memory:-proj-one', 'per-project memory dirs'], ['skills/beta', null]]);
  assert.deepEqual(claude.onlyB.map((item) => item.key), ['skills/gamma']);
  assert.deepEqual(claude.differ, [{ key: 'CLAUDE.md', a: 'sha=111', b: 'sha=222', noise: null }]);
  const repo = sections.find((row) => row.section === 'repo');
  assert.deepEqual(repo.onlyA, [{ key: '~/wt/app/one', value: 'wt/one@2222222', noise: 'worktrees under ~/wt' }]);
  const tool = sections.find((row) => row.section === 'tool');
  assert.deepEqual(tool.differ.map((item) => [item.key, item.noise]), [['brew', 'platform-specific tools'], ['gh', null]]);
  assert.equal(sections.find((row) => row.section === 'pi').same, 1);
});

test('the report hides the noisy classes as counts unless asked for all of it', () => {
  const sections = inventory.compareInventories(A, B);
  const report = inventory.renderComparison(sections, { nameA: 'main', nameB: 'mini' });
  assert.equal(report, [
    'main vs mini: 4 sections with differences, 1 identical',
    '',
    '## claude:~/.claude  same 2 · only on main 2 · only on mini 1 · differ 1',
    '  only on main:',
    '    skills/beta = dir sha=bbb',
    '  only on mini:',
    '    skills/gamma = dir sha=ccc',
    '  differ:',
    '    CLAUDE.md',
    '      main  sha=111',
    '      mini  sha=222',
    '  hidden: 1 per-project memory dirs (--all shows them)',
    '',
    '## repo  same 1 · only on main 1 · only on mini 0 · differ 0',
    '  hidden: 1 worktrees under ~/wt (--all shows them)',
    '',
    '## tool  same 0 · only on main 0 · only on mini 0 · differ 2',
    '  differ:',
    '    gh',
    '      main  present',
    '      mini  absent',
    '  hidden: 1 platform-specific tools (--all shows them)',
    '',
    '## tool-path  same 0 · only on main 0 · only on mini 0 · differ 1',
    '  hidden: 1 tool locations (--all shows them)',
    '',
    'identical: pi',
  ].join('\n'));
  const everything = inventory.renderComparison(sections, { nameA: 'main', nameB: 'mini', all: true });
  assert.match(everything, /memory:-proj-one = 1 files/);
  assert.match(everything, /~\/wt\/app\/one = wt\/one@2222222/);
  assert.match(everything, /brew\n {6}main {2}present\n {6}mini {2}absent/);
  assert.doesNotMatch(everything, /hidden:/);
});

test('keep node audit prints the daemon node beside the node, and says when a host is too old or stuck', async () => {
  const { nodeAudit } = require('./commands/nodes.js');
  const asked = [];
  let stuck = null;
  const client = (hello) => ({
    descriptor: hello,
    request: async (type, params, requestOptions) => {
      asked.push({ type, params, requestOptions });
      return { inventory: inventory.toLines(B), partial: false, stuck, version: 1 };
    },
    close() {},
  });
  const home = '/home/someone';
  const deps = {
    homedir: home,
    daemonNode: 'main',
    accounts: { list: () => [
      { agent: 'claude', configDir: `${home}/.claude` },
      { agent: 'claude', configDir: `${home}/.claude-second` },
      { agent: 'codex', configDir: `${home}/.codex` },
    ] },
    collectInventory: async (scope) => { asked.push({ type: 'local', params: scope }); return A; },
    connect: async () => client({ protocol: 1, inventory: 1 }),
    // The command exits once its report is out; here it only counts.
    exit: (code) => { exits.push(code); },
  };
  const exits = [];
  const lines = [];
  const original = console.log;
  console.log = (...args) => lines.push(args.join(' '));
  try {
    await nodeAudit(['mini'], deps);
    await nodeAudit(['mini', '--json'], deps);
    stuck = 'inventory stuck: filesystem';
    await nodeAudit(['mini'], deps);
  } finally { console.log = original; }
  assert.equal(lines[0], inventory.renderComparison(inventory.compareInventories(A, B), { nameA: 'main', nameB: 'mini' }));
  const json = JSON.parse(lines[1]);
  assert.equal(json.node, 'mini');
  assert.equal(json.daemonNode, 'main');
  assert.deepEqual(json.partial, { daemon: null, node: null });
  assert.equal(json.stuck, null);
  assert.equal(json.sections.length, 5);
  assert.match(lines[2], /^warning: node mini reports an earlier inventory stuck: filesystem/);
  assert.deepEqual(exits, [0, 0, 0], 'each run exits 0 once its report is out');
  const remote = asked.find((call) => call.type === 'inventory');
  const { salt, ...where } = remote.params;
  assert.deepEqual(where, {
    claudeDirs: ['~/.claude', '~/.claude-second'], codexDirs: ['~/.codex'], repoRoots: ['~', '~/wt'],
  }, 'the node is told where to look, relative to its own home');
  assert.match(salt, inventory.SALT_RE);
  assert.equal(remote.requestOptions.timeoutMs, 60e3);
  const local = asked.find((call) => call.type === 'local');
  assert.deepEqual(local.params.claudeDirs, [`${home}/.claude`, `${home}/.claude-second`]);
  assert.equal(local.params.salt, salt, 'both sides of one audit hash with the same salt');
  const second = asked.filter((call) => call.type === 'inventory')[1];
  assert.notEqual(second.params.salt, salt, 'and each audit has its own');

  await assert.rejects(nodeAudit(['mini'], { ...deps, connect: async () => client({ protocol: 1, stats: 1 }) }),
    /predates the inventory verb[\s\S]*git pull[\s\S]*keep host reload/);
  await assert.rejects(nodeAudit([], deps), /keep node audit <name>/);
  await assert.rejects(nodeAudit(['Bad'], deps), /lowercase letters and digits/);
  await assert.rejects(nodeAudit(['mini'], { ...deps, connect: async () => { throw new Error('refused'); } }), /cannot reach node mini: refused/);
});
