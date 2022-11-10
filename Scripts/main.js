let lastHeartbeat = 0;
let lastFile = '';
let cacheDebug = undefined;
let cachedArchitecture = undefined;
let cachedLatestCliVersion = undefined;

const githubDownloadPrefix = 'https://github.com/wakatime/wakatime-cli/releases/download';
const githubReleasesUrl = 'https://api.github.com/repos/wakatime/wakatime-cli/releases/latest';
const userAgent = 'nova/' + nova.versionString + ' nova-wakatime/' + nova.extension.version;

exports.activate = function () {
  log.debug('Initializing version ' + nova.extension.version);
  checkCli(() => {
    checkApiKey(() => {
      setupEventListeners(() => {
        log.debug('Finished initializing WakaTime extension');
      });
    });
  });
};

exports.deactivate = function () {
  log.debug('wakatime de-activated');
};

nova.commands.register('wakatime.dashboard', () => {
  openDashboardWebsite();
});

nova.commands.register('wakatime.apikey', () => {
  promptForApiKey();
});

nova.commands.register('wakatime.debug', () => {
  promptForDebugMode();
});

function setupEventListeners(callback) {
  nova.workspace.onDidAddTextEditor(editor => {
    if (!editor) return;
    editor.onDidStopChanging(onEvent);
    editor.onDidChangeSelection(onEvent);
    editor.onDidSave(e => onEvent(e, true));
  });
  callback();
}

function openDashboardWebsite() {
  nova.openURL('https://wakatime.com/dashboard');
}

function promptForApiKey(callback) {
  const apiKey = getApiKey();
  const options = {
    label: 'API Key',
    placeHolder: 'Find your api key from https://wakatime.com/api-key',
    value: apiKey,
    prompt: 'Save',
    secure: false,
  };
  nova.workspace.showInputPanel('', options, val => {
    if (isValidApiKey(val)) setSetting('settings', 'api_key', val, false);
    if (callback) callback();
  });
}

function promptForDebugMode(callback) {
  const debug = isDebugEnabled();
  const options = {
    placeholder: 'Debug mode currently ' + (debug ? 'enabled' : 'disabled'),
  };
  const choices = ['enable', 'disable'];
  nova.workspace.showChoicePalette(choices, options, val => {
    if (!choices.includes(val)) return;
    setSetting('settings', 'debug', val == 'enable' ? 'true' : 'false');
    cacheDebug = val == 'enable';
    if (callback) callback();
  });
}

function checkCli(callback) {
  isCliInstalled(installed => {
    if (!installed) {
      installCli(() => {
        log.debug('Finished installing wakatime-cli');
        callback();
      });
    } else {
      isCliLatest((latest) => {
        if (!latest) {
          installCli(() => {
            log.debug('Finished installing wakatime-cli');
            callback();
          });
        } else {
          callback();
        }
      });
    }
  });
}

function isCliInstalled(callback) {
  getCliLocation(cli => {
    callback(nova.fs.access(cli, nova.fs.X_OK));
  });
}

function getHomeDirectory() {
  let home = nova.environment.WAKATIME_HOME;
  if (home) {
    let trimmed = home.trim();
    let stats = nova.fs.stat(trimmed);
    if (stats && stats.isDirectory()) return trimmed;
  }

  return nova.environment.HOME;
}

function getResourcesLocation() {
  resourcesLocation = nova.path.join(getHomeDirectory(), '.wakatime');

  if (!nova.fs.access(resourcesLocation, nova.fs.X_OK)) nova.fs.mkdir(resourcesLocation);

  return resourcesLocation;
}

function getCliLocation(callback) {
  getArchitecture(arch => {
    callback(nova.path.join(getResourcesLocation(), `wakatime-cli-darwin-${arch}`));
  });
}

function checkApiKey(callback) {
  if (hasApiKey()) {
    callback();
  } else {
    promptForApiKey(callback);
  }
}

function installCli(callback) {
  getLatestCliVersion(version => {
    if (!version) {
      callback();
      return;
    }
    cliDownloadUrl(version, (url) => {
      downloadCli(url, () => {
        symlink(() => {
          callback();
        });
      });
    });
  });
}

function isCliLatest(callback) {
  getCliLocation(cli => {
    const options = { args: ['--version'] };
    var process = new Process(cli, options);
    var stderr = [];
    var stdout = [];

    process.onStderr(function (line) {
      stderr.push(line);
    });
    process.onStdout(function (line) {
      stdout.push(line);
    });
    process.onDidExit(exitCode => {
      if (stderr.length > 0) {
        log.error('Failed to check local wakatime-cli version with error: ' + stderr.join('\n'));
      }
      const currentVersion = stdout.join('\n').trim();
      log.debug(`Current wakatime-cli version is ${currentVersion}`);
      log.debug('Checking for updates to wakatime-cli...');

      getLatestCliVersion((latestVersion) => {
        if (currentVersion == latestVersion) {
          log.debug('wakatime-cli is up to date');
          callback(true);
        } else {
          if (latestVersion) {
            log.debug('Found new wakatime-cli version: ' + latestVersion);
            callback(false);
          } else {
            log.debug('Unable to get latest wakatime-cli version');
            callback(true);
          }
        }
      });
    });

    process.start();
  });
}

function getLatestCliVersion(callback) {
  if (cachedLatestCliVersion) {
    callback(cachedLatestCliVersion);
    return;
  }

  const proxy = getSetting('settings', 'proxy', false);
  const noSSLVerify = getSetting('settings', 'no_sll_verify', false);
  const modified = getSetting('internal', 'cli_version_last_modified', true);

  const opt = {
    json: true,
    headers: {
      'User-Agent': 'github.com/wakatime/WakaTime.novaextension',
    },
  }

  if (proxy) opt['proxy'] = proxy;
  if (noSSLVerify === 'true') opt['strictSSL'] = false;
  if (modified) opt['headers']['If-Modified-Since'] = modified;

  fetch(githubReleasesUrl, opt)
    .then(response => {
      if (response.status == 200 || response.status == 304) {
        log.debug(`GitHub API response ${response.status}`);

        if (response.status == 304) {
          const version = getSetting('internal', 'cli_version', true);
          if (version) {
            log.debug(`Latest wakatime-cli version from cache: ${version}`);
            cachedLatestCliVersion = version;
            callback(version);
            return;
          }
        }

        response.json().then(json => {
          const latestVersion = json['tag_name'];
          log.debug(`Latest wakatime-cli version from GitHub: ${latestVersion}`);

          const lastModified = response.headers['last-modified'];
          if (lastModified && latestVersion) {
            setSetting('internal', 'cli_version', latestVersion, true);
            setSetting('internal', 'cli_version_last_modified', lastModified, true);
          }
          cachedLatestCliVersion = latestVersion;
          callback(latestVersion);
        });

      } else {
        log.warn(`GitHub API response ${response.status}: ${response.status}`);
        callback();
      }
    })
    .catch(error => {
      log.error(error);
      callback();
    });
}

function downloadCli(url, callback) {
  log.debug('Downloading wakatime-cli from ' + url);

  fetch(url)
    .then(response => response.arrayBuffer())
    .then(buffer => {
      const folder = getResourcesLocation();
      const zipFile = folder + '/wakatime-cli.zip';
      const zip = nova.fs.open(zipFile, 'wb');
      zip.write(buffer);
      zip.close();
      unzip(zipFile, folder, () => {
        nova.fs.remove(zipFile);
        callback();
      });
    })
    .catch(error => {
      log.error(error);
      callback();
    });
}

function unzip(zipFile, intoFolder, callback) {
  log.debug('Extracting wakatime-cli.zip file...');

  const options = { args: ['-o', zipFile, '-d', intoFolder] };
  var process = new Process('/usr/bin/unzip', options);
  var stderr = [];

  try {
    process.onStderr(function (line) {
      stderr.push(line);
    });
    process.onDidExit(exitCode => {
      if (stderr.length > 0) {
        log.error('Failed to extract wakatime-cli.zip with error: ' + stderr.join('\n'));
      }

      callback();
    });

    process.start();
  } catch (e) {
    log.error(e);
  }
}

function hasApiKey() {
  return !!getApiKey();
}

function isValidApiKey(key) {
  if (!key) return false;
  const re = new RegExp(
    '^[0-9A-F]{8}-[0-9A-F]{4}-4[0-9A-F]{3}-[89AB][0-9A-F]{3}-[0-9A-F]{12}$',
    'i',
  );
  if (!re.test(key)) return false;
  return true;
}

function getSetting(section, key, internal) {
  let lines = [];
  try {
    const config = nova.fs.open(getConfigFile(internal), 'r', 'utf-8');
    lines = config.readlines();
    config.close();
  } catch (e) {
    return '';
  }
  if (!lines || lines.length == 0) return '';
  let currentSection = '';
  for (var i = 0; i < lines.length; i++) {
    let line = lines[i];
    if (startsWith(line.trim(), '[') && endsWith(line.trim(), ']')) {
      currentSection = line
        .trim()
        .substring(1, line.trim().length - 1)
        .toLowerCase();
    } else if (currentSection === section) {
      let parts = line.split('=');
      const currentKey = parts[0].trim();
      if (currentKey === key && parts.length > 1) {
        return parts[1].trim();
      }
    }
  }

  return '';
}

function setSetting(section, key, val, internal) {
  let lines = [];
  try {
    const config = nova.fs.open(getConfigFile(internal), 'r', 'utf-8');
    lines = config.readlines();
    config.close();
  } catch (e) {}

  let contents = [];
  let currentSection = '';

  let found = false;
  for (var i = 0; i < lines.length; i++) {
    let line = lines[i];
    if (startsWith(line.trim(), '[') && endsWith(line.trim(), ']')) {
      if (currentSection === section && !found) {
        contents.push(key + ' = ' + val);
        found = true;
      }
      currentSection = line
        .trim()
        .substring(1, line.trim().length - 1)
        .toLowerCase();
      contents.push(line.rtrim());
    } else if (currentSection === section) {
      const parts = line.split('=');
      const currentKey = parts[0].trim();
      if (currentKey === key) {
        if (!found) {
          contents.push(key + ' = ' + val);
          found = true;
        }
      } else {
        contents.push(line.rtrim());
      }
    } else {
      contents.push(line.rtrim());
    }
  }

  if (!found) {
    if (currentSection !== section) {
      contents.push('[' + section + ']');
    }
    contents.push(key + ' = ' + val);
  }

  const out = nova.fs.open(getConfigFile(internal), 'wx', 'utf-8');
  out.write(contents.join('\n'));
  out.close();
}

function getConfigFile(internal) {
  if (internal) {
    return nova.path.join(getHomeDirectory(), '.wakatime-internal.cfg');
  }
  return nova.path.join(getHomeDirectory(), '.wakatime.cfg');
}

function getApiKey() {
  const key = getSetting('settings', 'api_key', false);
  if (isValidApiKey(key)) return key;
  return '';
}

function isDebugEnabled() {
  if (cacheDebug === undefined) cacheDebug = getSetting('settings', 'debug', false) == 'true';
  return cacheDebug;
}

function startsWith(outer, inner) {
  return outer.slice(0, inner.length) === inner;
}

function endsWith(outer, inner) {
  return inner === '' || outer.slice(-inner.length) === inner;
}

function enoughTimePassed(time) {
  return lastHeartbeat + 120000 < time;
}

function onEvent(editor, isWrite) {
  if (!editor) return;

  let doc = editor.document;
  if (!doc) return;
  if (doc.isEmpty) return;

  let file = doc.path;
  if (!file) return;

  let time = Date.now();
  if (isWrite || enoughTimePassed(time) || lastFile !== file) {
    sendHeartbeat(file, isWrite, doc.syntax, getLocalFileIfRemote(doc));
    lastFile = file;
    lastHeartbeat = time;
  }
}

function getLocalFileIfRemote(doc) {
  if (!doc.isRemote) return null;

  const trimmedRange = new Range(0, doc.length > 128000 ? 128000 : doc.length);
  const buffer = doc.getTextInRange(trimmedRange);

  const tempFile = '/tmp/' + Date.now();
  const fh = nova.fs.open(tempFile, 'w');
  fh.write(buffer);
  fh.close();

  return tempFile;
}

function sendHeartbeat(file, isWrite, language, localFile) {
  let args = ['--entity', file.quote(), '--plugin', userAgent.quote()];

  if (isWrite) args.push('--write');

  if (language) {
    args.push('--language');
    args.push(language.quote());
  }

  if (localFile) {
    args.push('--local-file');
    args.push(localFile.quote());
  }

  getCliLocation(cli => {
    log.debug('Sending heartbeat:\n' + formatArguments(cli, args));

    const options = { args: args };

    var process = new Process(cli, options);
    var stderr = [];
    var stdout = [];

    try {
      process.onStderr(function (line) {
        stderr.push(line);
      });
      process.onStdout(function (line) {
        stdout.push(line);
      });
    } catch (e) {
      log.error(e);
    }
    process.onDidExit(exitCode => {
      if (exitCode == 0) {
        let today = new Date();
        log.debug('Last heartbeat sent ' + formatDate(today));
      } else {
        if (stderr.length > 0) log.error(stderr.join('\n'));
        if (stdout.length > 0) log.error(stdout.join('\n'));
        if (exitCode == 102 || exitCode == 112) {
          log.debug(
            'WakaTime Offline, coding activity will sync when online',
          );
        } else if (exitCode == 103) {
          log.error('An error occured while parsing ~/.wakatime.cfg. Check ~/.wakatime.log for more info');
        } else if (exitCode == 104) {
          log.error(
            'Invalid API Key. Make sure your API Key is correct!',
          );
        } else {
          log.error(
            'Unknown Error (' +
              exitCode.toString() +
              '); Check your ~/.wakatime.log file for more details.',
          );
        }
      }

      if (localFile) nova.fs.remove(localFile);
    });

    process.start();
  });
}

function formatArguments(binary, args) {
  let clone = args.slice(0);
  clone.unshift(binary.quote());
  let newCmds = [];
  let lastCmd = '';
  for (let i = 0; i < clone.length; i++) {
    if (lastCmd == '--key') newCmds.push(obfuscateKey(clone[i]).quote());
    else newCmds.push(clone[i].quote());
    lastCmd = clone[i];
  }
  return newCmds.join(' ');
}

function obfuscateKey(key) {
  let newKey = '';
  if (key) {
    newKey = key;
    if (key.length > 4) newKey = 'XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXX' + key.substring(key.length - 4);
  }
  return newKey;
}

function formatDate(date) {
  let months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  let ampm = 'AM';
  let hour = date.getHours();
  if (hour > 11) {
    ampm = 'PM';
    hour = hour - 12;
  }
  if (hour == 0) {
    hour = 12;
  }
  let minute = date.getMinutes();
  return (
    months[date.getMonth()] +
    ' ' +
    date.getDate() +
    ', ' +
    date.getFullYear() +
    ' ' +
    hour +
    ':' +
    (minute < 10 ? '0' + minute : minute) +
    ' ' +
    ampm
  );
}

function getArchitecture(callback) {
  if (cachedArchitecture) {
    callback(cachedArchitecture);
    return;
  }
  const binary = "/usr/bin/uname";
  const options = { args: ["-m"]};
  var process = new Process(binary, options);
  var stderr = [];
  var stdout = [];
  try {
    process.onStderr(function (line) {
      stderr.push(line);
    });
    process.onStdout(function (line) {
      stdout.push(line);
    });
  } catch (e) {
    log.error(e);
  }
  process.onDidExit(() => {
    let arch = "amd64";
    if (stdout.join('\n').includes("arm")) {
      arch = "arm64";
    }
    cachedArchitecture = arch;
    callback(arch);
  });
  process.start();
}

function cliDownloadUrl(version, callback) {
  getArchitecture(arch => {
    callback(`${githubDownloadPrefix}/${version}/wakatime-cli-darwin-${arch}.zip`);
  });
}

function symlink(callback) {
  getCliLocation(cli => {
    const binary = "/bin/ln";
    const options = { args: ["-s", "-f", cli, nova.path.join(getResourcesLocation(), 'wakatime-cli')]};
    var process = new Process(binary, options);
    process.onDidExit(() => {
      callback();
    });
    process.start();
  });
}

const log = {
  debug: function (msg) {
    if (!isDebugEnabled()) return;
    console.log('[WakaTime] [DEBUG] ' + msg);
  },
  info: function (msg) {
    console.info('[WakaTime] [INFO] ' + msg);
  },
  warn: function (msg) {
    console.warn('[WakaTime] [WARN] ' + msg);
  },
  error: function (msg) {
    console.error('[WakaTime] [ERROR] ' + msg);
  },
};

if (typeof String.prototype.trim === 'undefined') {
  String.prototype.trim = function () {
    return String(this).replace(/^\s+|\s+$/g, '');
  };
}

if (typeof String.prototype.rtrim === 'undefined') {
  String.prototype.rtrim = function () {
    return String(this).replace(/\s+$/g, '');
  };
}

if (typeof String.prototype.quote === 'undefined') {
  String.prototype.quote = function () {
    const str = String(this);
    if (str.includes(' ')) return '"' + str.replace('"', '\\"') + '"';
    return str;
  };
}
