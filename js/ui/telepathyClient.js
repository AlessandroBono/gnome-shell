/* -*- mode: js2; js2-basic-offset: 4; indent-tabs-mode: nil -*- */

const DBus = imports.dbus;
const GLib = imports.gi.GLib;
const Lang = imports.lang;
const Mainloop = imports.mainloop;
const Signals = imports.signals;
const St = imports.gi.St;
const Tp = imports.gi.TelepathyGLib;
const Gettext = imports.gettext.domain('gnome-shell');
const _ = Gettext.gettext;

const Main = imports.ui.main;
const MessageTray = imports.ui.messageTray;
const Telepathy = imports.misc.telepathy;

let contactManager;
let channelDispatcher;

// See Notification.appendMessage
const SCROLLBACK_IMMEDIATE_TIME = 60; // 1 minute
const SCROLLBACK_RECENT_TIME = 15 * 60; // 15 minutes
const SCROLLBACK_RECENT_LENGTH = 20;
const SCROLLBACK_IDLE_LENGTH = 5;

// The (non-chat) channel indicating the users whose presence
// information we subscribe to
let subscribedContactsChannel = {};
subscribedContactsChannel[Tp.PROP_CHANNEL_CHANNEL_TYPE] = Tp.IFACE_CHANNEL_TYPE_CONTACT_LIST
subscribedContactsChannel[Tp.PROP_CHANNEL_TARGET_HANDLE_TYPE] = Tp.HandleType.LIST;
subscribedContactsChannel[Tp.PROP_CHANNEL_TARGET_ID] = 'subscribe';

const NotificationDirection = {
    SENT: 'chat-sent',
    RECEIVED: 'chat-received'
};

// This is GNOME Shell's implementation of the Telepathy 'Client'
// interface. Specifically, the shell is a Telepathy 'Observer', which
// lets us see messages even if they belong to another app (eg,
// Empathy).

function Client() {
    this._init();
};

Client.prototype = {
    _init : function() {
        this._accounts = {};
        this._sources = {};

        contactManager = new ContactManager();
        contactManager.connect('presence-changed', Lang.bind(this, this._presenceChanged));

        channelDispatcher = new Telepathy.ChannelDispatcher(DBus.session,
                                                            Tp.CHANNEL_DISPATCHER_BUS_NAME,
                                                            Tp.CHANNEL_DISPATCHER_OBJECT_PATH);

        // Set up a SimpleObserver, which will call _observeChannels whenever a
        // channel matching its filters is detected.
        // The second argument, recover, means _observeChannels will be run
        // for any existing channel as well.
        let dbus = Tp.DBusDaemon.dup();
        this._observer = Tp.SimpleObserver.new(dbus, true, 'GnomeShell', true,
                                              Lang.bind(this, this._observeChannels));

        // We only care about single-user text-based chats
        let props = {};
        props[Tp.PROP_CHANNEL_TARGET_HANDLE_TYPE] = Tp.IFACE_CHANNEL_TYPE_TEXT;
        props[Tp.PROP_CHANNEL_TARGET_HANDLE_TYPE] = Tp.HandleType.CONTACT;
        this._observer.add_observer_filter(props);

        try {
            this._observer.register();
        } catch (e) {
            throw new Error('Couldn\'t register SimpleObserver. Error: \n' + e);
        }
    },

    _observeChannels: function(observer, account, conn, channels,
                               dispatchOp, requests, context) {
        let connPath = conn.get_object_path();

        let len = channels.length;
        for (let i = 0; i < len; i++) {
            let channel = channels[i];
            let [targetHandle, targetHandleType] = channel.get_handle();

            /* Only observe contact text channels */
            if ((!(channel instanceof Tp.TextChannel)) ||
               targetHandleType != Tp.HandleType.CONTACT)
               continue;

            if (this._sources[connPath + ':' + targetHandle])
                continue;

            let source = new Source(account, conn, chan);

            this._sources[connPath + ':' + targetHandle] = source;
            source.connect('destroy', Lang.bind(this,
                function() {
                    delete this._sources[connPath + ':' + targetHandle];
                }));

        }

        // Allow dbus method to return
        context.accept();
    },

    _presenceChanged: function(contactManager, connPath, handle,
                               type, message) {
        let source = this._sources[connPath + ':' + handle];
        if (!source)
            return;

        source.setPresence(type, message);
    }
};

function ContactManager() {
    this._init();
};

ContactManager.prototype = {
    _init: function() {
        this._connections = {};
        // Note that if we changed this to '/telepathy/avatars' then
        // we would share cache files with empathy. But since this is
        // not documented/guaranteed, it seems a little sketchy
        this._cacheDir = GLib.get_user_cache_dir() + '/gnome-shell/avatars';
    },

    addConnection: function(connPath) {
        let info = this._connections[connPath];
        if (info)
            return info;

        info = {};

        // Figure out the cache subdirectory for this connection by
        // parsing the connection manager name (eg, 'gabble') and
        // protocol name (eg, 'jabber') from the Connection's path.
        // Telepathy requires the D-Bus path for a connection to have
        // a specific form, and explicitly says that clients are
        // allowed to parse it.
        let match = connPath.match(/\/org\/freedesktop\/Telepathy\/Connection\/([^\/]*\/[^\/]*)\/.*/);
        if (!match)
            throw new Error('Could not parse connection path ' + connPath);

        info.cacheDir = this._cacheDir + '/' + match[1];
        GLib.mkdir_with_parents(info.cacheDir, 0x1c0); // 0x1c0 = octal 0700

        // info.names[handle] is @handle's real name
        // info.tokens[handle] is the token for @handle's avatar
        info.names = {};
        info.tokens = {};

        // info.icons[handle] is an array of the icon actors currently
        // being displayed for @handle. These will be updated
        // automatically if @handle's avatar changes.
        info.icons = {};

        let connName = Telepathy.pathToName(connPath);

        info.connectionAvatars = new Telepathy.ConnectionAvatars(DBus.session, connName, connPath);
        info.updatedId = info.connectionAvatars.connect(
            'AvatarUpdated', Lang.bind(this, this._avatarUpdated));
        info.retrievedId = info.connectionAvatars.connect(
            'AvatarRetrieved', Lang.bind(this, this._avatarRetrieved));

        info.connectionContacts = new Telepathy.ConnectionContacts(DBus.session, connName, connPath);

        info.connectionPresence = new Telepathy.ConnectionSimplePresence(DBus.session, connName, connPath);
        info.presenceChangedId = info.connectionPresence.connect(
            'PresencesChanged', Lang.bind(this, this._presencesChanged));

        let conn = new Telepathy.Connection(DBus.session, connName, connPath);
        info.statusChangedId = conn.connect('StatusChanged', Lang.bind(this,
            function (status, reason) {
                if (status == Tp.ConnectionStatus.DISCONNECTED)
                    this._removeConnection(conn);
            }));

        let connReq = new Telepathy.ConnectionRequests(DBus.session,
                                                       connName, connPath);
        connReq.EnsureChannelRemote(subscribedContactsChannel, Lang.bind(this,
            function (result, err) {
                if (!result)
                    return;

                let [mine, channelPath, props] = result;
                this._gotContactsChannel(connPath, channelPath, props);
            }));

        this._connections[connPath] = info;
        return info;
    },

    _gotContactsChannel: function(connPath, channelPath, props) {
        let info = this._connections[connPath];
        if (!info)
            return;

        info.contactsGroup = new Telepathy.ChannelGroup(DBus.session,
                                                        Telepathy.pathToName(connPath),
                                                        channelPath);
        info.contactsListChangedId =
            info.contactsGroup.connect('MembersChanged', Lang.bind(this, this._contactsListChanged, info));

        info.contactsGroup.GetRemote('Members', Lang.bind(this,
            function(contacts, err) {
                if (!contacts)
                    return;

                info.connectionContacts.GetContactAttributesRemote(
                    contacts, [Tp.IFACE_CONNECTION_INTERFACE_ALIASING], false,
                    Lang.bind(this, this._gotContactAttributes, info));
            }));
    },

    _contactsListChanged: function(group, message, added, removed,
                                   local_pending, remote_pending,
                                   actor, reason, info) {
        for (let i = 0; i < removed.length; i++)
            delete info.names[removed[i]];

        info.connectionContacts.GetContactAttributesRemote(
            added, [Tp.IFACE_CONNECTION_INTERFACE_ALIASING], false,
            Lang.bind(this, this._gotContactAttributes, info));
    },

    _gotContactAttributes: function(attrs, err, info) {
        if (!attrs)
            return;

        for (let handle in attrs)
            info.names[handle] = attrs[handle][Tp.TOKEN_CONNECTION_INTERFACE_ALIASING_ALIAS];
    },

    _presencesChanged: function(conn, presences, err) {
        if (!presences)
            return;

        let info = this._connections[conn.getPath()];
        if (!info)
            return;

        for (let handle in presences) {
            let [type, status, message] = presences[handle];
            this.emit('presence-changed', conn.getPath(), handle, type, message);
        }
    },

    _removeConnection: function(conn) {
        let info = this._connections[conn.getPath()];
        if (!info)
            return;

        conn.disconnect(info.statusChangedId);
        info.connectionAvatars.disconnect(info.updatedId);
        info.connectionAvatars.disconnect(info.retrievedId);
        info.connectionPresence.disconnect(info.presenceChangedId);
        info.contactsGroup.disconnect(info.contactsListChangedId);

        delete this._connections[conn.getPath()];
    },

    _getFileForToken: function(info, token) {
        return info.cacheDir + '/' + Telepathy.escapeAsIdentifier(token);
    },

    _setIcon: function(iconBox, info, handle) {
        let textureCache = St.TextureCache.get_default();
        let token = info.tokens[handle];
        let file;

        if (token) {
            file = this._getFileForToken(info, token);
            if (!GLib.file_test(file, GLib.FileTest.EXISTS))
                file = null;
        }

        if (file) {
            let uri = GLib.filename_to_uri(file, null);
            iconBox.child = textureCache.load_uri_async(uri, iconBox._size, iconBox._size);
        } else {
            iconBox.child = new St.Icon({ icon_name: 'stock_person',
                                          icon_type: St.IconType.FULLCOLOR,
                                          icon_size: iconBox._size });
        }
    },

    _updateIcons: function(info, handle) {
        if (!info.icons[handle])
            return;

        for (let i = 0; i < info.icons[handle].length; i++) {
            let iconBox = info.icons[handle][i];
            this._setIcon(iconBox, info, handle);
        }
    },

    _avatarUpdated: function(conn, handle, token) {
        let info = this._connections[conn.getPath()];
        if (!info)
            return;

        if (info.tokens[handle] == token)
            return;

        info.tokens[handle] = token;
        if (token != '') {
            let file = this._getFileForToken(info, token);
            if (!GLib.file_test(file, GLib.FileTest.EXISTS)) {
                info.connectionAvatars.RequestAvatarsRemote([handle]);
                return;
            }
        }

        this._updateIcons(info, handle);
    },

    _avatarRetrieved: function(conn, handle, token, avatarData, mimeType) {
        let info = this._connections[conn.getPath()];
        if (!info)
            return;

        let file = this._getFileForToken(info, token);
        let success = false;
        try {
            success = GLib.file_set_contents(file, avatarData, avatarData.length);
        } catch (e) {
            logError(e, 'Error caching avatar data');
        }

        if (success)
            this._updateIcons(info, handle);
    },

    createAvatar: function(conn, handle, size) {
        let iconBox = new St.Bin({ style_class: 'avatar-box' });
        iconBox._size = size;

        let info = this._connections[conn.get_object_path()];
        if (!info)
            info = this.addConnection(conn.get_object_path());

        if (!info.icons[handle])
            info.icons[handle] = [];
        info.icons[handle].push(iconBox);

        iconBox.connect('destroy', Lang.bind(this,
            function() {
                let i = info.icons[handle].indexOf(iconBox);
                if (i != -1)
                    info.icons[handle].splice(i, 1);
            }));

        // If we already have the icon cached and know its token, this
        // will fill it in. Otherwise it will fill in the default
        // icon.
        this._setIcon(iconBox, info, handle);

        // Asynchronously load the real avatar if we don't have it yet.
        if (info.tokens[handle] == null) {
            info.connectionAvatars.GetKnownAvatarTokensRemote([handle], Lang.bind(this,
                function (tokens, err) {
                    let token = tokens && tokens[handle] ? tokens[handle] : '';
                    this._avatarUpdated(info.connectionAvatars, handle, token);
                }));
        }

        return iconBox;
    }
};
Signals.addSignalMethods(ContactManager.prototype);


function Source(account, conn, channel) {
    this._init(account, conn, channel);
}

Source.prototype = {
    __proto__:  MessageTray.Source.prototype,

    _init: function(account, conn, channel) {
        // FIXME: use chan.get_handle()
        let props = channel.borrow_immutable_properties();
        this._targetHandle = props[Tp.PROP_CHANNEL_TARGET_HANDLE];
        this._targetHandleType = props[Tp.PROP_CHANNEL_TARGET_HANDLE_TYPE];
        this._targetId = channel.get_identifier();

        MessageTray.Source.prototype._init.call(this, this._targetId);

        this.isChat = true;

        this._account = account;

        this._conn = conn;
        this._channel = channel;
        this._closedId = this._channel.connect('invalidated', Lang.bind(this, this._channelClosed));

        if (this._targetHandleType == Tp.HandleType.CONTACT) {
            let aliasing = new Telepathy.ConnectionAliasing(DBus.session, conn.get_bus_name(), conn.get_object_path());
            aliasing.RequestAliasesRemote([this._targetHandle], Lang.bind(this,
                function (aliases, err) {
                    if (aliases && aliases.length)
                        this.title = aliases[0];
                }));
        }

        this._notification = new Notification(this);
        this._notification.setUrgency(MessageTray.Urgency.HIGH);

        // Since we only create sources when receiving a message, this
        // is a plausible default
        this._presence = Tp.ConnectionPresenceType.AVAILABLE;

        this._channelText = new Telepathy.ChannelText(DBus.session, conn.get_bus_name(), channel.get_object_path());
        this._sentId = this._channelText.connect('Sent', Lang.bind(this, this._messageSent));
        this._receivedId = this._channelText.connect('Received', Lang.bind(this, this._messageReceived));

        this._channelText.ListPendingMessagesRemote(false, Lang.bind(this, this._gotPendingMessages));

        this._setSummaryIcon(this.createNotificationIcon());
    },

    createNotificationIcon: function() {
        return contactManager.createAvatar(this._conn, this._targetHandle,
                                           this.ICON_SIZE);
    },

    _notificationClicked: function(notification) {
        let props = {};
        props[Tp.PROP_CHANNEL_CHANNEL_TYPE] = Tp.IFACE_CHANNEL_TYPE_TEXT;
        props[Tp.PROP_CHANNEL_TARGET_HANDLE] = this._targetHandle;
        props[Tp.PROP_CHANNEL_TARGET_HANDLE_TYPE] = this._targetHandleType;
        channelDispatcher.EnsureChannelRemote(this._account.get_object_path(), props,
                                              global.get_current_time(),
                                              '',
                                              Lang.bind(this, this._gotChannelRequest));
    },

    _gotChannelRequest: function (chanReqPath, ex) {
        if (ex) {
            log ('EnsureChannelRemote failed? ' + ex);
            return;
        }

        let chanReq = new Telepathy.ChannelRequest(DBus.session, Tp.CHANNEL_DISPATCHER_BUS_NAME, chanReqPath);
        chanReq.ProceedRemote();
    },

    _gotPendingMessages: function(msgs, err) {
        if (!msgs)
            return;

        for (let i = 0; i < msgs.length; i++)
            this._messageReceived.apply(this, [this._channel].concat(msgs[i]));
    },

    _channelClosed: function() {
        this._channel.disconnect(this._closedId);
        this._channelText.disconnect(this._receivedId);
        this._channelText.disconnect(this._sentId);
        this.destroy();
    },

    _messageReceived: function(channel, id, timestamp, sender,
                               type, flags, text) {
        this._notification.appendMessage(text, timestamp, NotificationDirection.RECEIVED);
        this.notify();
    },

    // This is called for both messages we send from
    // our client and other clients as well.
    _messageSent: function(channel, timestamp, type, text) {
        this._notification.appendMessage(text, timestamp, NotificationDirection.SENT);
    },

    notify: function() {
        if (!Main.messageTray.contains(this))
            Main.messageTray.add(this);

        MessageTray.Source.prototype.notify.call(this, this._notification);
    },

    respond: function(text) {
        this._channelText.SendRemote(Tp.ChannelTextMessageType.NORMAL, text);
    },

    setPresence: function(presence, message) {
        let msg, shouldNotify, title;

        title = GLib.markup_escape_text(this.title, -1);

        if (presence == Tp.ConnectionPresenceType.AVAILABLE) {
            msg = _("%s is online.").format(title);
            shouldNotify = (this._presence == Tp.ConnectionPresenceType.OFFLINE);
        } else if (presence == Tp.ConnectionPresenceType.OFFLINE ||
                   presence == Tp.ConnectionPresenceType.EXTENDED_AWAY) {
            presence = Tp.ConnectionPresenceType.OFFLINE;
            msg = _("%s is offline.").format(title);
            shouldNotify = (this._presence != Tp.ConnectionPresenceType.OFFLINE);
        } else if (presence == Tp.ConnectionPresenceType.AWAY) {
            msg = _("%s is away.").format(title);
            shouldNotify = false;
        } else if (presence == Tp.ConnectionPresenceType.BUSY) {
            msg = _("%s is busy.").format(title);
            shouldNotify = false;
        } else
            return;

        this._presence = presence;

        if (message)
            msg += ' <i>(' + GLib.markup_escape_text(message, -1) + ')</i>';

        this._notification.appendPresence(msg, shouldNotify);
        if (shouldNotify)
            this.notify();
    }
};

function Notification(source) {
    this._init(source);
}

Notification.prototype = {
    __proto__:  MessageTray.Notification.prototype,

    _init: function(source) {
        MessageTray.Notification.prototype._init.call(this, source, source.title, null, { customContent: true });
        this.setResident(true);

        this._responseEntry = new St.Entry({ style_class: 'chat-response',
                                             can_focus: true });
        this._responseEntry.clutter_text.connect('activate', Lang.bind(this, this._onEntryActivated));
        this.setActionArea(this._responseEntry);

        this._history = [];
        this._timestampTimeoutId = 0;
    },

    appendMessage: function(text, timestamp, direction) {
        this.update(this.source.title, text, { customContent: true });
        this._append(text, direction, timestamp);
    },

    _append: function(text, style, timestamp) {
        let currentTime = (Date.now() / 1000);
        if (!timestamp)
            timestamp = currentTime;
        let lastMessageTime = -1;
        if (this._history.length > 0)
            lastMessageTime = this._history[0].time;

        // Reset the old message timeout
        if (this._timestampTimeoutId)
            Mainloop.source_remove(this._timestampTimeoutId);

        let body = this.addBody(text);
        body.add_style_class_name(style);
        this.scrollTo(St.Side.BOTTOM);

        this._history.unshift({ actor: body, time: timestamp, realMessage: true });

        if (timestamp < currentTime - SCROLLBACK_IMMEDIATE_TIME)
            this._appendTimestamp();
        else
            // Schedule a new timestamp in SCROLLBACK_IMMEDIATE_TIME
            // from the timestamp of the message.
            this._timestampTimeoutId = Mainloop.timeout_add_seconds(
                SCROLLBACK_IMMEDIATE_TIME - (currentTime - timestamp),
                Lang.bind(this, this._appendTimestamp));

        if (this._history.length > 1) {
            // Keep the scrollback from growing too long. If the most
            // recent message (before the one we just added) is within
            // SCROLLBACK_RECENT_TIME, we will keep
            // SCROLLBACK_RECENT_LENGTH previous messages. Otherwise
            // we'll keep SCROLLBACK_IDLE_LENGTH messages.

            let maxLength = (lastMessageTime < currentTime - SCROLLBACK_RECENT_TIME) ?
                SCROLLBACK_IDLE_LENGTH : SCROLLBACK_RECENT_LENGTH;
            let filteredHistory = this._history.filter(function(item) { return item.realMessage });
            if (filteredHistory.length > maxLength) {
                let lastMessageToKeep = filteredHistory[maxLength];
                let expired = this._history.splice(this._history.indexOf(lastMessageToKeep));
                for (let i = 0; i < expired.length; i++)
                    expired[i].actor.destroy();
            }
        }
    },

    _appendTimestamp: function() {
        let lastMessageTime = this._history[0].time;
        let lastMessageDate = new Date(lastMessageTime * 1000);

        /* Translators: this is a time format string followed by a date.
           If applicable, replace %X with a strftime format valid for your
           locale, without seconds. */
        // xgettext:no-c-format
        let timeLabel = this.addBody(lastMessageDate.toLocaleFormat(_("Sent at %X on %A")), false, { expand: true, x_fill: false, x_align: St.Align.END });
        timeLabel.add_style_class_name('chat-meta-message');
        this._history.unshift({ actor: timeLabel, time: lastMessageTime, realMessage: false });

        this._timestampTimeoutId = 0;
        return false;
    },

    appendPresence: function(text, asTitle) {
        if (asTitle)
            this.update(text, null, { customContent: true, titleMarkup: true });
        else
            this.update(this.source.title, null, { customContent: true });
        let label = this.addBody(text, true);
        label.add_style_class_name('chat-meta-message');
        this._history.unshift({ actor: label, time: (Date.now() / 1000), realMessage: false});
    },

    _onEntryActivated: function() {
        let text = this._responseEntry.get_text();
        if (text == '')
            return;

        // Telepathy sends out the Sent signal for us.
        // see Source._messageSent
        this._responseEntry.set_text('');
        this.source.respond(text);
    }
};
