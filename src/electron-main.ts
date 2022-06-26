/*
Copyright 2016 Aviral Dasgupta
Copyright 2016 OpenMarket Ltd
Copyright 2017, 2019 Michael Telatynski <7t3chguy@gmail.com>
Copyright 2018 - 2021 New Vector Ltd

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/

// Squirrel on windows starts the app with various flags as hooks to tell us when we've been installed/uninstalled etc.
import "./squirrelhooks";
import {
    app,
    ipcMain,
    powerSaveBlocker,
    BrowserWindow,
    Menu,
    autoUpdater,
    protocol,
    dialog,
    desktopCapturer,
} from "electron";
import AutoLaunch from "auto-launch";
import path from "path";
import windowStateKeeper from 'electron-window-state';
import Store from 'electron-store';
import fs, { promises as afs } from "fs";
import crypto from "crypto";
import { URL } from "url";
import minimist from "minimist";

import type * as Keytar from "keytar"; // Hak dependency type
import type {
    Seshat as SeshatType,
    SeshatRecovery as SeshatRecoveryType,
    ReindexError as ReindexErrorType,
} from "matrix-seshat"; // Hak dependency type
import * as tray from "./tray";
import { buildMenuTemplate } from './vectormenu';
import webContentsHandler from './webcontents-handler';
import * as updater from './updater';
import { getProfileFromDeeplink, protocolInit, recordSSOSession } from './protocol';
import { _t, AppLocalization } from './language-helper';
import Input = Electron.Input;
import IpcMainEvent = Electron.IpcMainEvent;

const argv = minimist(process.argv, {
    alias: { help: "h" },
});

let keytar: typeof Keytar;
try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    keytar = require('keytar');
} catch (e) {
    if (e.code === "MODULE_NOT_FOUND") {
        console.log("Keytar isn't installed; secure key storage is disabled.");
    } else {
        console.warn("Keytar unexpected error:", e);
    }
}

let seshatSupported = false;
let Seshat: typeof SeshatType;
let SeshatRecovery: typeof SeshatRecoveryType;
let ReindexError: typeof ReindexErrorType;

try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const seshatModule = require('matrix-seshat');
    Seshat = seshatModule.Seshat;
    SeshatRecovery = seshatModule.SeshatRecovery;
    ReindexError = seshatModule.ReindexError;
    seshatSupported = true;
} catch (e) {
    if (e.code === "MODULE_NOT_FOUND") {
        console.log("Seshat isn't installed, event indexing is disabled.");
    } else {
        console.warn("Seshat unexpected error:", e);
    }
}

// Things we need throughout the file but need to be created
// async to are initialised in setupGlobals()
let asarPath: string;
let resPath: string;
let iconPath: string;

let vectorConfig: Record<string, any>;
let trayConfig: {
    // eslint-disable-next-line camelcase
    icon_path: string;
    brand: string;
};
let launcher: AutoLaunch;
let appLocalization: AppLocalization;

if (argv["help"]) {
    console.log("Options:");
    console.log("  --profile-dir {path}: Path to where to store the profile.");
    console.log("  --profile {name}:     Name of alternate profile to use, allows for running multiple accounts.");
    console.log("  --devtools:           Install and use react-devtools and react-perf.");
    console.log("  --no-update:          Disable automatic updating.");
    console.log("  --hidden:             Start the application hidden in the system tray.");
    console.log("  --help:               Displays this help message.");
    console.log("And more such as --proxy, see:" +
        "https://electronjs.org/docs/api/command-line-switches");
    app.exit();
}

// Electron creates the user data directory (with just an empty 'Dictionaries' directory...)
// as soon as the app path is set, so pick a random path in it that must exist if it's a
// real user data directory.
function isRealUserDataDir(d: string): boolean {
    return fs.existsSync(path.join(d, 'IndexedDB'));
}

// check if we are passed a profile in the SSO callback url
let userDataPath: string;

const userDataPathInProtocol = getProfileFromDeeplink(argv["_"]);
if (userDataPathInProtocol) {
    userDataPath = userDataPathInProtocol;
} else if (argv['profile-dir']) {
    userDataPath = argv['profile-dir'];
} else {
    let newUserDataPath = app.getPath('userData');
    if (argv['profile']) {
        newUserDataPath += '-' + argv['profile'];
    }
    const newUserDataPathExists = isRealUserDataDir(newUserDataPath);
    let oldUserDataPath = path.join(app.getPath('appData'), app.getName().replace('Element', 'Riot'));
    if (argv['profile']) {
        oldUserDataPath += '-' + argv['profile'];
    }

    const oldUserDataPathExists = isRealUserDataDir(oldUserDataPath);
    console.log(newUserDataPath + " exists: " + (newUserDataPathExists ? 'yes' : 'no'));
    console.log(oldUserDataPath + " exists: " + (oldUserDataPathExists ? 'yes' : 'no'));
    if (!newUserDataPathExists && oldUserDataPathExists) {
        console.log("Using legacy user data path: " + oldUserDataPath);
        userDataPath = oldUserDataPath;
    } else {
        userDataPath = newUserDataPath;
    }
}
app.setPath('userData', userDataPath);

async function tryPaths(name: string, root: string, rawPaths: string[]): Promise<string> {
    // Make everything relative to root
    const paths = rawPaths.map(p => path.join(root, p));

    for (const p of paths) {
        try {
            await afs.stat(p);
            return p + '/';
        } catch (e) {
        }
    }
    console.log(`Couldn't find ${name} files in any of: `);
    for (const p of paths) {
        console.log("\t"+path.resolve(p));
    }
    throw new Error(`Failed to find ${name} files`);
}

// Find the webapp resources and set up things that require them
async function setupGlobals(): Promise<void> {
    // find the webapp asar.
    asarPath = await tryPaths("webapp", __dirname, [
        // If run from the source checkout, this will be in the directory above
        '../webapp.asar',
        // but if run from a packaged application, electron-main.js will be in
        // a different asar file so it will be two levels above
        '../../webapp.asar',
        // also try without the 'asar' suffix to allow symlinking in a directory
        '../webapp',
        // from a packaged application
        '../../webapp',
    ]);

    // we assume the resources path is in the same place as the asar
    resPath = await tryPaths("res", path.dirname(asarPath), [
        // If run from the source checkout
        'res',
        // if run from packaged application
        '',
    ]);

    try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        vectorConfig = require(asarPath + 'config.json');
    } catch (e) {
        // it would be nice to check the error code here and bail if the config
        // is unparsable, but we get MODULE_NOT_FOUND in the case of a missing
        // file or invalid json, so node is just very unhelpful.
        // Continue with the defaults (ie. an empty config)
        vectorConfig = {};
    }

    try {
        // Load local config and use it to override values from the one baked with the build
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const localConfig = require(path.join(app.getPath('userData'), 'config.json'));

        // If the local config has a homeserver defined, don't use the homeserver from the build
        // config. This is to avoid a problem where Riot thinks there are multiple homeservers
        // defined, and panics as a result.
        const homeserverProps = ['default_is_url', 'default_hs_url', 'default_server_name', 'default_server_config'];
        if (Object.keys(localConfig).find(k => homeserverProps.includes(k))) {
            // Rip out all the homeserver options from the vector config
            vectorConfig = Object.keys(vectorConfig)
                .filter(k => !homeserverProps.includes(k))
                .reduce((obj, key) => {obj[key] = vectorConfig[key]; return obj;}, {});
        }

        vectorConfig = Object.assign(vectorConfig, localConfig);
    } catch (e) {
        if (e instanceof SyntaxError) {
            dialog.showMessageBox({
                type: "error",
                title: `Your ${vectorConfig.brand || 'Element'} is misconfigured`,
                message: `Your custom ${vectorConfig.brand || 'Element'} configuration contains invalid JSON. ` +
                         `Please correct the problem and reopen ${vectorConfig.brand || 'Element'}.`,
                detail: e.message || "",
            });
        }

        // Could not load local config, this is expected in most cases.
    }

    // The tray icon
    // It's important to call `path.join` so we don't end up with the packaged asar in the final path.
    const iconFile = `element.${process.platform === 'win32' ? 'ico' : 'png'}`;
    iconPath = path.join(resPath, "img", iconFile);
    trayConfig = {
        icon_path: iconPath,
        brand: vectorConfig.brand || 'Element',
    };

    // launcher
    launcher = new AutoLaunch({
        name: vectorConfig.brand || 'Element',
        isHidden: true,
        mac: {
            useLaunchAgent: true,
        },
    });
}

async function moveAutoLauncher(): Promise<void> {
    // Look for an auto-launcher under 'Riot' and if we find one, port it's
    // enabled/disabled-ness over to the new 'Element' launcher
    if (!vectorConfig.brand || vectorConfig.brand === 'Element') {
        const oldLauncher = new AutoLaunch({
            name: 'Riot',
            isHidden: true,
            mac: {
                useLaunchAgent: true,
            },
        });
        const wasEnabled = await oldLauncher.isEnabled();
        if (wasEnabled) {
            await oldLauncher.disable();
            await launcher.enable();
        }
    }
}

const eventStorePath = path.join(app.getPath('userData'), 'EventStore');
const store = new Store<{
    warnBeforeExit?: boolean;
    minimizeToTray?: boolean;
    spellCheckerEnabled?: boolean;
    autoHideMenuBar?: boolean;
    locale?: string | string[];
    disableHardwareAcceleration?: boolean;
}>({ name: "electron-config" });

let eventIndex: SeshatType = null;

let mainWindow: BrowserWindow = null;
global.appQuitting = false;

const exitShortcuts: Array<(input: Input, platform: string) => boolean> = [
    (input, platform) => platform !== 'darwin' && input.alt && input.key.toUpperCase() === 'F4',
    (input, platform) => platform !== 'darwin' && input.control && input.key.toUpperCase() === 'Q',
    (input, platform) => platform === 'darwin' && input.meta && input.key.toUpperCase() === 'Q',
];

const warnBeforeExit = (event: Event, input: Input): void => {
    const shouldWarnBeforeExit = store.get('warnBeforeExit', true);
    const exitShortcutPressed =
        input.type === 'keyDown' && exitShortcuts.some(shortcutFn => shortcutFn(input, process.platform));

    if (shouldWarnBeforeExit && exitShortcutPressed) {
        const shouldCancelCloseRequest = dialog.showMessageBoxSync(mainWindow, {
            type: "question",
            buttons: [_t("Cancel"), _t("Close Element")],
            message: _t("Are you sure you want to quit?"),
            defaultId: 1,
            cancelId: 0,
        }) === 0;

        if (shouldCancelCloseRequest) {
            event.preventDefault();
        }
    }
};

const deleteContents = async (p: string): Promise<void> => {
    for (const entry of await afs.readdir(p)) {
        const curPath = path.join(p, entry);
        await afs.unlink(curPath);
    }
};

async function randomArray(size: number): Promise<string> {
    return new Promise((resolve, reject) => {
        crypto.randomBytes(size, (err, buf) => {
            if (err) {
                reject(err);
            } else {
                resolve(buf.toString("base64").replace(/=+$/g, ''));
            }
        });
    });
}

// handle uncaught errors otherwise it displays
// stack traces in popup dialogs, which is terrible (which
// it will do any time the auto update poke fails, and there's
// no other way to catch this error).
// Assuming we generally run from the console when developing,
// this is far preferable.
process.on('uncaughtException', function(error: Error): void {
    console.log('Unhandled exception', error);
});

let focusHandlerAttached = false;
ipcMain.on('setBadgeCount', function(_ev: IpcMainEvent, count: number): void {
    if (process.platform !== 'win32') {
        // only set badgeCount on Mac/Linux, the docs say that only those platforms support it but turns out Electron
        // has some Windows support too, and in some Windows environments this leads to two badges rendering atop
        // each other. See https://github.com/vector-im/element-web/issues/16942
        app.badgeCount = count;
    }
    if (count === 0 && mainWindow) {
        mainWindow.flashFrame(false);
    }
});

ipcMain.on('loudNotification', function(): void {
    if (process.platform === 'win32' && mainWindow && !mainWindow.isFocused() && !focusHandlerAttached) {
        mainWindow.flashFrame(true);
        mainWindow.once('focus', () => {
            mainWindow.flashFrame(false);
            focusHandlerAttached = false;
        });
        focusHandlerAttached = true;
    }
});

let powerSaveBlockerId: number = null;
ipcMain.on('app_onAction', function(_ev: IpcMainEvent, payload) {
    switch (payload.action) {
        case 'call_state':
            if (powerSaveBlockerId !== null && powerSaveBlocker.isStarted(powerSaveBlockerId)) {
                if (payload.state === 'ended') {
                    powerSaveBlocker.stop(powerSaveBlockerId);
                    powerSaveBlockerId = null;
                }
            } else {
                if (powerSaveBlockerId === null && payload.state === 'connected') {
                    powerSaveBlockerId = powerSaveBlocker.start('prevent-display-sleep');
                }
            }
            break;
    }
});

interface Setting {
    read(): Promise<any>;
    write(value: any): Promise<void>;
}

const settings: Record<string, Setting> = {
    "Electron.autoLaunch": {
        async read(): Promise<any> {
            return launcher.isEnabled();
        },
        async write(value: any): Promise<void> {
            if (value) {
                return launcher.enable();
            } else {
                return launcher.disable();
            }
        },
    },
    "Electron.warnBeforeExit": {
        async read(): Promise<any> {
            return store.get("warnBeforeExit", true);
        },
        async write(value: any): Promise<void> {
            store.set("warnBeforeExit", value);
        },
    },
    "Electron.alwaysShowMenuBar": { // not supported on macOS
        async read(): Promise<any> {
            return !global.mainWindow.autoHideMenuBar;
        },
        async write(value: any): Promise<void> {
            store.set('autoHideMenuBar', !value);
            global.mainWindow.autoHideMenuBar = !value;
            global.mainWindow.setMenuBarVisibility(value);
        },
    },
    "Electron.showTrayIcon": { // not supported on macOS
        async read(): Promise<any> {
            return tray.hasTray();
        },
        async write(value: any): Promise<void> {
            if (value) {
                // Create trayIcon icon
                tray.create(trayConfig);
            } else {
                tray.destroy();
            }
            store.set('minimizeToTray', value);
        },
    },
    "Electron.enableHardwareAcceleration": {
        async read(): Promise<any> {
            return !store.get('disableHardwareAcceleration', false);
        },
        async write(value: any): Promise<void> {
            store.set('disableHardwareAcceleration', !value);
        },
    },
};

ipcMain.on('ipcCall', async function(_ev: IpcMainEvent, payload) {
    if (!mainWindow) return;

    const args = payload.args || [];
    let ret: any;

    switch (payload.name) {
        case 'getUpdateFeedUrl':
            ret = autoUpdater.getFeedURL();
            break;
        case 'getSettingValue': {
            const [settingName] = args;
            const setting = settings[settingName];
            ret = await setting.read();
            break;
        }
        case 'setSettingValue': {
            const [settingName, value] = args;
            const setting = settings[settingName];
            await setting.write(value);
            break;
        }
        case 'setLanguage':
            appLocalization.setAppLocale(args[0]);
            break;
        case 'getAppVersion':
            ret = app.getVersion();
            break;
        case 'focusWindow':
            if (mainWindow.isMinimized()) {
                mainWindow.restore();
            } else if (!mainWindow.isVisible()) {
                mainWindow.show();
            } else {
                mainWindow.focus();
            }
            break;
        case 'getConfig':
            ret = vectorConfig;
            break;
        case 'navigateBack':
            if (mainWindow.webContents.canGoBack()) {
                mainWindow.webContents.goBack();
            }
            break;
        case 'navigateForward':
            if (mainWindow.webContents.canGoForward()) {
                mainWindow.webContents.goForward();
            }
            break;
        case 'setSpellCheckEnabled':
            if (typeof args[0] !== 'boolean') return;

            mainWindow.webContents.session.setSpellCheckerEnabled(args[0]);
            store.set("spellCheckerEnabled", args[0]);

            break;

        case 'getSpellCheckEnabled':
            ret = store.get("spellCheckerEnabled", true);
            break;

        case 'setSpellCheckLanguages':
            try {
                mainWindow.webContents.session.setSpellCheckerLanguages(args[0]);
            } catch (er) {
                console.log("There were problems setting the spellcheck languages", er);
            }
            break;

        case 'getSpellCheckLanguages':
            ret = mainWindow.webContents.session.getSpellCheckerLanguages();
            break;

        case 'getAvailableSpellCheckLanguages':
            ret = mainWindow.webContents.session.availableSpellCheckerLanguages;
            break;

        case 'startSSOFlow':
            recordSSOSession(args[0]);
            break;

        case 'getPickleKey':
            try {
                ret = await keytar.getPassword("element.io", `${args[0]}|${args[1]}`);
                // migrate from riot.im (remove once we think there will no longer be
                // logins from the time of riot.im)
                if (ret === null) {
                    ret = await keytar.getPassword("riot.im", `${args[0]}|${args[1]}`);
                }
            } catch (e) {
                // if an error is thrown (e.g. keytar can't connect to the keychain),
                // then return null, which means the default pickle key will be used
                ret = null;
            }
            break;

        case 'createPickleKey':
            try {
                const pickleKey = await randomArray(32);
                await keytar.setPassword("element.io", `${args[0]}|${args[1]}`, pickleKey);
                ret = pickleKey;
            } catch (e) {
                ret = null;
            }
            break;

        case 'destroyPickleKey':
            try {
                await keytar.deletePassword("element.io", `${args[0]}|${args[1]}`);
                // migrate from riot.im (remove once we think there will no longer be
                // logins from the time of riot.im)
                await keytar.deletePassword("riot.im", `${args[0]}|${args[1]}`);
            } catch (e) {}
            break;
        case 'getDesktopCapturerSources':
            ret = (await desktopCapturer.getSources(args[0])).map((source) => ({
                id: source.id,
                name: source.name,
                thumbnailURL: source.thumbnail.toDataURL(),
            }));
            break;

        default:
            mainWindow.webContents.send('ipcReply', {
                id: payload.id,
                error: "Unknown IPC Call: " + payload.name,
            });
            return;
    }

    mainWindow.webContents.send('ipcReply', {
        id: payload.id,
        reply: ret,
    });
});

const seshatDefaultPassphrase = "DEFAULT_PASSPHRASE";
async function getOrCreatePassphrase(key: string): Promise<string> {
    if (keytar) {
        try {
            const storedPassphrase = await keytar.getPassword("element.io", key);
            if (storedPassphrase !== null) {
                return storedPassphrase;
            } else {
                const newPassphrase = await randomArray(32);
                await keytar.setPassword("element.io", key, newPassphrase);
                return newPassphrase;
            }
        } catch (e) {
            console.log("Error getting the event index passphrase out of the secret store", e);
        }
    } else {
        return seshatDefaultPassphrase;
    }
}

ipcMain.on('seshat', async function(_ev: IpcMainEvent, payload): Promise<void> {
    if (!mainWindow) return;

    const sendError = (id, e) => {
        const error = {
            message: e.message,
        };

        mainWindow.webContents.send('seshatReply', {
            id: id,
            error: error,
        });
    };

    const args = payload.args || [];
    let ret: any;

    switch (payload.name) {
        case 'supportsEventIndexing':
            ret = seshatSupported;
            break;

        case 'initEventIndex':
            if (eventIndex === null) {
                const userId = args[0];
                const deviceId = args[1];
                const passphraseKey = `seshat|${userId}|${deviceId}`;

                const passphrase = await getOrCreatePassphrase(passphraseKey);

                try {
                    await afs.mkdir(eventStorePath, { recursive: true });
                    eventIndex = new Seshat(eventStorePath, { passphrase });
                } catch (e) {
                    if (e instanceof ReindexError) {
                        // If this is a reindex error, the index schema
                        // changed. Try to open the database in recovery mode,
                        // reindex the database and finally try to open the
                        // database again.
                        const recoveryIndex = new SeshatRecovery(eventStorePath, {
                            passphrase,
                        });

                        const userVersion = await recoveryIndex.getUserVersion();

                        // If our user version is 0 we'll delete the db
                        // anyways so reindexing it is a waste of time.
                        if (userVersion === 0) {
                            await recoveryIndex.shutdown();

                            try {
                                await deleteContents(eventStorePath);
                            } catch (e) {
                            }
                        } else {
                            await recoveryIndex.reindex();
                        }

                        eventIndex = new Seshat(eventStorePath, { passphrase });
                    } else {
                        sendError(payload.id, e);
                        return;
                    }
                }
            }
            break;

        case 'closeEventIndex':
            if (eventIndex !== null) {
                const index = eventIndex;
                eventIndex = null;

                try {
                    await index.shutdown();
                } catch (e) {
                    sendError(payload.id, e);
                    return;
                }
            }
            break;

        case 'deleteEventIndex':
            {
                try {
                    await deleteContents(eventStorePath);
                } catch (e) {
                }
            }

            break;

        case 'isEventIndexEmpty':
            if (eventIndex === null) ret = true;
            else ret = await eventIndex.isEmpty();
            break;

        case 'isRoomIndexed':
            if (eventIndex === null) ret = false;
            else ret = await eventIndex.isRoomIndexed(args[0]);
            break;

        case 'addEventToIndex':
            try {
                eventIndex.addEvent(args[0], args[1]);
            } catch (e) {
                sendError(payload.id, e);
                return;
            }
            break;

        case 'deleteEvent':
            try {
                ret = await eventIndex.deleteEvent(args[0]);
            } catch (e) {
                sendError(payload.id, e);
                return;
            }
            break;

        case 'commitLiveEvents':
            try {
                ret = await eventIndex.commit();
            } catch (e) {
                sendError(payload.id, e);
                return;
            }
            break;

        case 'searchEventIndex':
            try {
                ret = await eventIndex.search(args[0]);
            } catch (e) {
                sendError(payload.id, e);
                return;
            }
            break;

        case 'addHistoricEvents':
            if (eventIndex === null) ret = false;
            else {
                try {
                    ret = await eventIndex.addHistoricEvents(
                        args[0], args[1], args[2]);
                } catch (e) {
                    sendError(payload.id, e);
                    return;
                }
            }
            break;

        case 'getStats':
            if (eventIndex === null) ret = 0;
            else {
                try {
                    ret = await eventIndex.getStats();
                } catch (e) {
                    sendError(payload.id, e);
                    return;
                }
            }
            break;

        case 'removeCrawlerCheckpoint':
            if (eventIndex === null) ret = false;
            else {
                try {
                    ret = await eventIndex.removeCrawlerCheckpoint(args[0]);
                } catch (e) {
                    sendError(payload.id, e);
                    return;
                }
            }
            break;

        case 'addCrawlerCheckpoint':
            if (eventIndex === null) ret = false;
            else {
                try {
                    ret = await eventIndex.addCrawlerCheckpoint(args[0]);
                } catch (e) {
                    sendError(payload.id, e);
                    return;
                }
            }
            break;

        case 'loadFileEvents':
            if (eventIndex === null) ret = [];
            else {
                try {
                    ret = await eventIndex.loadFileEvents(args[0]);
                } catch (e) {
                    sendError(payload.id, e);
                    return;
                }
            }
            break;

        case 'loadCheckpoints':
            if (eventIndex === null) ret = [];
            else {
                try {
                    ret = await eventIndex.loadCheckpoints();
                } catch (e) {
                    ret = [];
                }
            }
            break;

        case 'setUserVersion':
            if (eventIndex === null) break;
            else {
                try {
                    await eventIndex.setUserVersion(args[0]);
                } catch (e) {
                    sendError(payload.id, e);
                    return;
                }
            }
            break;

        case 'getUserVersion':
            if (eventIndex === null) ret = 0;
            else {
                try {
                    ret = await eventIndex.getUserVersion();
                } catch (e) {
                    sendError(payload.id, e);
                    return;
                }
            }
            break;

        default:
            mainWindow.webContents.send('seshatReply', {
                id: payload.id,
                error: "Unknown IPC Call: " + payload.name,
            });
            return;
    }

    mainWindow.webContents.send('seshatReply', {
        id: payload.id,
        reply: ret,
    });
});

app.commandLine.appendSwitch('--enable-usermedia-screen-capturing');
if (!app.commandLine.hasSwitch('enable-features')) {
    app.commandLine.appendSwitch('enable-features', 'WebRTCPipeWireCapturer');
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
    console.log('Other instance detected: exiting');
    app.exit();
}

// do this after we know we are the primary instance of the app
protocolInit();

// Register the scheme the app is served from as 'standard'
// which allows things like relative URLs and IndexedDB to
// work.
// Also mark it as secure (ie. accessing resources from this
// protocol and HTTPS won't trigger mixed content warnings).
protocol.registerSchemesAsPrivileged([{
    scheme: 'vector',
    privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
    },
}]);

// Turn the sandbox on for *all* windows we might generate. Doing this means we don't
// have to specify a `sandbox: true` to each BrowserWindow.
//
// This also fixes an issue with window.open where if we only specified the sandbox
// on the main window we'd run into cryptic "ipc_renderer be broke" errors. Turns out
// it's trying to jump the sandbox and make some calls into electron, which it can't
// do when half of it is sandboxed. By turning on the sandbox for everything, the new
// window (no matter how temporary it may be) is also sandboxed, allowing for a clean
// transition into the user's browser.
app.enableSandbox();

// We disable media controls here. We do this because calls use audio and video elements and they sometimes capture the media keys. See https://github.com/vector-im/element-web/issues/15704
app.commandLine.appendSwitch('disable-features', 'HardwareMediaKeyHandling,MediaSessionService');

// Disable hardware acceleration if the setting has been set.
if (store.get('disableHardwareAcceleration', false) === true) {
    console.log("Disabling hardware acceleration.");
    app.disableHardwareAcceleration();
}

app.on('ready', async () => {
    try {
        await setupGlobals();
        await moveAutoLauncher();
    } catch (e) {
        console.log("App setup failed: exiting", e);
        process.exit(1);
        // process.exit doesn't cause node to stop running code immediately,
        // so return (we could let the exception propagate but then we end up
        // with node printing all sorts of stuff about unhandled exceptions
        // when we want the actual error to be as obvious as possible).
        return;
    }

    if (argv['devtools']) {
        try {
            // eslint-disable-next-line @typescript-eslint/no-var-requires
            const { default: installExt, REACT_DEVELOPER_TOOLS, REACT_PERF } = require('electron-devtools-installer');
            installExt(REACT_DEVELOPER_TOOLS)
                .then((name) => console.log(`Added Extension: ${name}`))
                .catch((err) => console.log('An error occurred: ', err));
            installExt(REACT_PERF)
                .then((name) => console.log(`Added Extension: ${name}`))
                .catch((err) => console.log('An error occurred: ', err));
        } catch (e) {
            console.log(e);
        }
    }

    protocol.registerFileProtocol('vector', (request, callback) => {
        if (request.method !== 'GET') {
            callback({ error: -322 }); // METHOD_NOT_SUPPORTED from chromium/src/net/base/net_error_list.h
            return null;
        }

        const parsedUrl = new URL(request.url);
        if (parsedUrl.protocol !== 'vector:') {
            callback({ error: -302 }); // UNKNOWN_URL_SCHEME
            return;
        }
        if (parsedUrl.host !== 'vector') {
            callback({ error: -105 }); // NAME_NOT_RESOLVED
            return;
        }

        const target = parsedUrl.pathname.split('/');

        // path starts with a '/'
        if (target[0] !== '') {
            callback({ error: -6 }); // FILE_NOT_FOUND
            return;
        }

        if (target[target.length - 1] == '') {
            target[target.length - 1] = 'index.html';
        }

        let baseDir: string;
        if (target[1] === 'webapp') {
            baseDir = asarPath;
        } else {
            callback({ error: -6 }); // FILE_NOT_FOUND
            return;
        }

        // Normalise the base dir and the target path separately, then make sure
        // the target path isn't trying to back out beyond its root
        baseDir = path.normalize(baseDir);

        const relTarget = path.normalize(path.join(...target.slice(2)));
        if (relTarget.startsWith('..')) {
            callback({ error: -6 }); // FILE_NOT_FOUND
            return;
        }
        const absTarget = path.join(baseDir, relTarget);

        callback({
            path: absTarget,
        });
    });

    if (argv['no-update']) {
        console.log('Auto update disabled via command line flag "--no-update"');
    } else if (vectorConfig['update_base_url']) {
        console.log(`Starting auto update with base URL: ${vectorConfig['update_base_url']}`);
        updater.start(vectorConfig['update_base_url']);
    } else {
        console.log('No update_base_url is defined: auto update is disabled');
    }

    // Load the previous window state with fallback to defaults
    const mainWindowState = windowStateKeeper({
        defaultWidth: 1024,
        defaultHeight: 768,
    });

    const preloadScript = path.normalize(`${__dirname}/preload.js`);
    mainWindow = global.mainWindow = new BrowserWindow({
        // https://www.electronjs.org/docs/faq#the-font-looks-blurry-what-is-this-and-what-can-i-do
        backgroundColor: '#fff',

        icon: iconPath,
        show: false,
        autoHideMenuBar: store.get('autoHideMenuBar', true),

        x: mainWindowState.x,
        y: mainWindowState.y,
        width: mainWindowState.width,
        height: mainWindowState.height,
        webPreferences: {
            preload: preloadScript,
            nodeIntegration: false,
            //sandbox: true, // We enable sandboxing from app.enableSandbox() above
            contextIsolation: true,
            webgl: true,
        },
    });
    mainWindow.loadURL('vector://vector/webapp/');

    // Handle spellchecker
    // For some reason spellCheckerEnabled isn't persisted so we have to use the store here
    mainWindow.webContents.session.setSpellCheckerEnabled(store.get("spellCheckerEnabled", true));

    // Create trayIcon icon
    if (store.get('minimizeToTray', true)) tray.create(trayConfig);

    mainWindow.once('ready-to-show', () => {
        mainWindowState.manage(mainWindow);

        if (!argv['hidden']) {
            mainWindow.show();
        } else {
            // hide here explicitly because window manage above sometimes shows it
            mainWindow.hide();
        }
    });

    mainWindow.webContents.on('before-input-event', warnBeforeExit);

    mainWindow.on('closed', () => {
        mainWindow = global.mainWindow = null;
    });
    mainWindow.on('close', async (e) => {
        // If we are not quitting and have a tray icon then minimize to tray
        if (!global.appQuitting && (tray.hasTray() || process.platform === 'darwin')) {
            // On Mac, closing the window just hides it
            // (this is generally how single-window Mac apps
            // behave, eg. Mail.app)
            e.preventDefault();

            if (mainWindow.isFullScreen()) {
                mainWindow.once('leave-full-screen', () => mainWindow.hide());

                mainWindow.setFullScreen(false);
            } else {
                mainWindow.hide();
            }

            return false;
        }
    });

    if (process.platform === 'win32') {
        // Handle forward/backward mouse buttons in Windows
        mainWindow.on('app-command', (e, cmd) => {
            if (cmd === 'browser-backward' && mainWindow.webContents.canGoBack()) {
                mainWindow.webContents.goBack();
            } else if (cmd === 'browser-forward' && mainWindow.webContents.canGoForward()) {
                mainWindow.webContents.goForward();
            }
        });
    }

    webContentsHandler(mainWindow.webContents);

    appLocalization = new AppLocalization({
        store,
        components: [
            () => tray.initApplicationMenu(),
            () => Menu.setApplicationMenu(buildMenuTemplate()),
        ],
    });
});

app.on('window-all-closed', () => {
    app.quit();
});

app.on('activate', () => {
    mainWindow.show();
});

function beforeQuit(): void {
    global.appQuitting = true;
    if (mainWindow) {
        mainWindow.webContents.send('before-quit');
    }
}

app.on('before-quit', beforeQuit);
autoUpdater.on('before-quit-for-update', beforeQuit);

app.on('second-instance', (ev, commandLine, workingDirectory) => {
    // If other instance launched with --hidden then skip showing window
    if (commandLine.includes('--hidden')) return;

    // Someone tried to run a second instance, we should focus our window.
    if (mainWindow) {
        if (!mainWindow.isVisible()) mainWindow.show();
        if (mainWindow.isMinimized()) mainWindow.restore();
        mainWindow.focus();
    }
});

// Set the App User Model ID to match what the squirrel
// installer uses for the shortcut icon.
// This makes notifications work on windows 8.1 (and is
// a noop on other platforms).
app.setAppUserModelId('com.squirrel.element-desktop.Element');
