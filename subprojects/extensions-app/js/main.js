import Adw from 'gi://Adw?version=1';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';

import {setConsoleLogDomain} from 'console';
const Package = imports.package;

Package.initFormat();

import {ExtensionsWindow} from './extensionsWindow.js';

const GnomeShellIface = loadInterfaceXML('org.gnome.Shell.Extensions');
const GnomeShellProxy = Gio.DBusProxy.makeProxyWrapper(GnomeShellIface);

function loadInterfaceXML(iface) {
    const uri = `resource:///org/gnome/Extensions/dbus-interfaces/${iface}.xml`;
    const f = Gio.File.new_for_uri(uri);

    try {
        let [ok_, bytes] = f.load_contents(null);
        return new TextDecoder().decode(bytes);
    } catch (e) {
        console.error(`Failed to load D-Bus interface ${iface}`);
    }

    return null;
}

var Application = GObject.registerClass(
class Application extends Adw.Application {
    _init() {
        GLib.set_prgname('gnome-extensions-app');
        super._init({application_id: Package.name});

        this.connect('window-removed', (a, window) => window.run_dispose());
    }

    get shellProxy() {
        return this._shellProxy;
    }

    vfunc_activate() {
        this._shellProxy.CheckForUpdatesAsync().catch(console.error);
        this._window.present();
    }

    vfunc_startup() {
        super.vfunc_startup();

        this.add_action_entries(
            [{
                name: 'quit',
                activate: () => this._window.close(),
            }]);

        this.set_accels_for_action('app.quit', ['<Primary>q']);

        this._shellProxy = new GnomeShellProxy(Gio.DBus.session,
            'org.gnome.Shell.Extensions', '/org/gnome/Shell/Extensions');

        this._window = new ExtensionsWindow({application: this});
    }
});

/**
 * Main entrypoint for the app
 *
 * @param {string[]} argv - command line arguments
 * @returns {void}
 */
export async function main(argv) {
    Package.initGettext();
    setConsoleLogDomain('Extensions');

    await new Application().runAsync(argv);
}
