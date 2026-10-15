function faviconURL(u) {
    const url = new URL(chrome.runtime.getURL('/_favicon/'));
    url.searchParams.set('pageUrl', u);
    url.searchParams.set('size', '32');
    return url.toString();
}

// Enter pressed before saved groups have loaded still saves the open tabs (see o_help_quickAdd)
var enter_pressed_early = false;

function onEarlyEnter(e) {
    if (e.keyCode === 13) {
        enter_pressed_early = true;
    }
}

document.getElementById('new_group_name').addEventListener('keyup', onEarlyEnter, false);

chrome.storage.session.get(function (session_storage_items) {
    chrome.storage.local.get(function (session_items) {
        var list_error = null;

        // options come from sync storage, saved groups from the group store
        Promise.all([
            chrome.storage.sync.get(),
            groupStoreClient.list().catch(function (e) {
                list_error = e;
                return {};
            }),
        ]).then(function (results) {
            var storage_items = results[0],
                saved_groups = results[1];

            /**
             * Popup window for edit operation
             * @param popup_id
             * @param callback {function} fired on submit.
             */
            function Popup(popup_id, callback) {
                this.popup_container = document.querySelector('#' + popup_id);
                this.callback = callback;
                this.go();
            }

            Popup.prototype = {
                go: function () {
                    var self = this,
                        data_container = self.popup_container.querySelectorAll('.data'),
                        submit_btn = this.popup_container.querySelector('.submit_btn');

                    function submitData() {
                        var data = {};
                        [].forEach.call(data_container, function (el) {
                            data[el.id] = el.value;
                        });
                        self.popup_container.style.display = 'none';
                        self.callback(data);
                    }

                    this.popup_container.style.display = 'block';
                    if (data_container.length) {
                        data_container[0].focus();
                        data_container[0].select();
                        // submit on 'enter' for last text input
                        if (data_container[data_container.length - 1].getAttribute('type') === 'text') {
                            data_container[data_container.length - 1].onkeyup = function (e) {
                                if (e.keyCode === 13) {
                                    submitData();
                                }
                            };
                        }
                    } else {
                        submit_btn.focus();
                        this.popup_container.onkeyup = function (e) {
                            if (e.keyCode === 13) {
                                submitData();
                            }
                        };
                    }

                    submit_btn.onclick = function (e) {
                        submitData();
                    };

                    this.popup_container.querySelector('.cancel').onclick = function (e) {
                        self.popup_container.style.display = 'none';
                    };
                },
            };


            // Sessions live in chrome.storage.local, saved groups in the group store (background service worker).
            // Callbacks get {err: 0|1, msg?, results?}. For saved groups err is 1 only when nothing was saved;
            // results[storage_name] = {synced, error?, copy?} tells whether the change also reached sync storage.
            var backends = {
                session: {
                    save: function (items, callback) {
                        chrome.storage.local.set(items, function () {
                            callback(chrome.runtime.lastError ? {err: 1, msg: chrome.runtime.lastError.message} : {err: 0});
                        });
                    },
                    remove: function (storage_name, callback) {
                        chrome.storage.local.remove(storage_name, function () {
                            callback(chrome.runtime.lastError ? {err: 1, msg: chrome.runtime.lastError.message} : {err: 0});
                        });
                    },
                },
                saved: {
                    save: function (items, callback) {
                        groupStoreClient.saveMany(items).then(function (results) {
                            callback({err: 0, results: results});
                        }, function (e) {
                            callback({err: 1, msg: e.message});
                        });
                    },
                    remove: function (storage_name, callback) {
                        groupStoreClient.remove(storage_name).then(function () {
                            callback({err: 0});
                        }, function (e) {
                            callback({err: 1, msg: e.message});
                        });
                    },
                },
            };

            function GroupModel(area) {
                this.backend = backends[area];
                // called with results after saved groups are written
                this.onSaved = null;
                // all saved groups as object
                this.data_local_copy = (function () {
                    var item,
                        groups_data = area === 'session' ? session_items : saved_groups,
                        obj = {};

                    for (item in groups_data) {
                        if (item.indexOf('tg_') === 0) {
                            obj[item] = groups_data[item];
                        }
                    }
                    return obj;
                }());
            }

            GroupModel.prototype = {
                getGroups: function () {
                    return this.data_local_copy;
                },

                getStorageNameByName: function (name) {
                    var storage_name;

                    for (storage_name in this.data_local_copy) {
                        if (this.data_local_copy[storage_name].name === name) {
                            return storage_name;
                        }
                    }
                    return false;
                },

                nextIndex: function () {
                    var last_index = 0,
                        group;

                    for (group in this.data_local_copy) {
                        if (this.data_local_copy[group].index > last_index) {
                            last_index = this.data_local_copy[group].index;
                        }
                    }
                    return last_index + 1;
                },

                del: function (storage_name, callback) {
                    var self = this;

                    this.backend.remove(storage_name, function (answ) {
                        if (answ.err === 0) {
                            delete self.data_local_copy[storage_name];
                        }
                        callback(answ);
                    });
                },

                // write {storage_name: group, ...} and keep the local copy in step
                save: function (items, callback) {
                    var self = this;

                    this.backend.save(items, function (answ) {
                        if (answ.err === 0) {
                            Object.keys(items).forEach(function (storage_name) {
                                if (answ.results) {
                                    items[storage_name].synced = answ.results[storage_name].synced;
                                }
                                self.data_local_copy[storage_name] = items[storage_name];
                            });
                            if (answ.results && self.onSaved) {
                                self.onSaved(answ.results);
                            }
                        }
                        callback(answ);
                    });
                },

                add: function (name, group, callback) {
                    var storage_name = 'tg_' + (new Date()).getTime(),
                        items = {};

                    items[storage_name] = {
                        name: name === undefined || name.length === 0 ? '' : name,
                        index: this.nextIndex(),
                        tabs: group,
                    };
                    this.save(items, function (answ) {
                        answ.storage_name = storage_name;
                        answ.new_group = items[storage_name];
                        callback(answ);
                    });
                },

                upd: function (storage_name, value, callback) {
                    var items = {};

                    items[storage_name] = value;
                    this.save(items, function (answ) {
                        answ.storage_name = storage_name;
                        answ.new_group = value;
                        callback(answ);
                    });
                },

                move: function (storage_name, sibling_storage_name, callback) {
                    var groups = this.data_local_copy,
                        items = {};

                    // copies: the local copy changes only once the write succeeds
                    items[storage_name] = Object.assign({}, groups[storage_name], {index: groups[sibling_storage_name].index});
                    items[sibling_storage_name] = Object.assign({}, groups[sibling_storage_name], {index: groups[storage_name].index});
                    this.save(items, callback);
                },
            };


            function LinkModel(area) {
                this.model = area === 'session' ? sessionModel : groupModel;
            }

            LinkModel.prototype = {
                getLocalLinkIndexById: function (storage_name, link_id) {
                    var i,
                        tabs = (this.model.getGroups())[storage_name].tabs,
                        max = tabs.length;

                    for (i = 0; i < max; i++) {
                        if (tabs[i].id === parseInt(link_id, 10)) {
                            return i;
                        }
                    }
                },

                groupLinksByWindowId: function (storage_name) {
                    var tabs = (this.model.getGroups())[storage_name].tabs,
                        windows = [], // arr with unique windowId
                        grouped_by_windows = []; // links grouped by windowId [[{tab1}, {tab2}],[{tab3}]]...

                    tabs.forEach(function (el) {
                        var window_index = windows.indexOf(el.windowId);
                        if (window_index === -1) {
                            windows.push(el.windowId);
                            grouped_by_windows.push([]);
                            grouped_by_windows[windows.length - 1].push(el);
                        } else {
                            grouped_by_windows[window_index].push(el);
                        }
                    });
                    return {grouped_by_windowId: grouped_by_windows, windowId_arr: windows};
                },

                nextIndex: function (storage_name) {
                    var tabs = (this.model.getGroups())[storage_name].tabs,
                        last_index = 0;

                    tabs.forEach(function (el) {
                        if (el.id > last_index) {
                            last_index = el.id;
                        }
                    });
                    return last_index + 1;
                },

                del: function (storage_name, link_id, callback) {
                    var group = (this.model.getGroups())[storage_name];
                    group.tabs.splice(this.getLocalLinkIndexById(storage_name, link_id), 1);

                    this.model.upd(storage_name, group, function (answ) {
                        callback(answ);
                    });
                },

                add: function (storage_name, link_data, callback) {
                    var group = (this.model.getGroups())[storage_name];

                    group.tabs.push(link_data);
                    this.model.upd(storage_name, group, function (answ) {
                        callback(answ);
                    });
                },

                upd: function (storage_name, link_index, link_data, callback) {
                    var group = (this.model.getGroups())[storage_name];

                    group.tabs[link_index] = link_data;
                    this.model.upd(storage_name, group, function (answ) {
                        callback(answ);
                    });
                },
            };

            var groupModel = new GroupModel('saved'),
                linkModel = new LinkModel('saved'),
                sessionModel = new GroupModel('session'),
                sessionLinkModel = new LinkModel('session'),
                TAB_TITLE_LENGTH = 48,
                ui_msg = {
                    title_del_group: chrome.i18n.getMessage('p_delGroup_btn_title'),
                    title_edit_group_name: chrome.i18n.getMessage('p_editGroupName_btn_title'),
                    title_add_link_to_group: chrome.i18n.getMessage('p_addLinkToGroup_btn_title'),
                    title_group_in_new_window: chrome.i18n.getMessage('p_groupInNewWindow_btn_title'),
                    title_edit_link: chrome.i18n.getMessage('p_editLink_btn_title'),
                    title_del_link: chrome.i18n.getMessage('p_delLinkFromGroup_btn_title'),
                    title_up_link: chrome.i18n.getMessage('p_upGroup_btn_title'),
                    title_down_link: chrome.i18n.getMessage('p_downGroup_btn_title'),

                    windows_numbers: chrome.i18n.getMessage('p_windowsNumbers_text'),
                    tabs_numbers: chrome.i18n.getMessage('p_tabsNumbers_text'),

                    window_text: chrome.i18n.getMessage('p_window_text'),

                    error_default: chrome.i18n.getMessage('p_syncStorageDefault_error'),

                    current_session: chrome.i18n.getMessage('p_currentSession'),

                    not_synced: chrome.i18n.getMessage('p_notSynced_title'),
                    saved_locally_full: chrome.i18n.getMessage('p_savedLocally_full'),
                    saved_locally_later: chrome.i18n.getMessage('p_savedLocally_later'),
                    nothing_to_save: chrome.i18n.getMessage('p_nothingToSave'),
                },

                tabsGrabber = {
                    tabsFilter: function () {
                        var obj = {};

                        if (storage_items.cur_win) {
                            obj.currentWindow = true;
                        }
                        return obj;
                    },

                    collectTabs: function (callback) {
                        chrome.tabs.query(this.tabsFilter(), function (tabs) {
                            var links = [];

                            tabs.forEach(function (tab, index) {
                                var link = {};

                                if (!tab.pinned || storage_items.pinned === 1) {
                                    link.url = tab.url;
                                    link.title = tab.title;
                                    link.id = index;
                                    if (tab.pinned) {
                                        link.pinned = tab.pinned;
                                    }
                                    links.push(link);
                                }
                            });
                            callback(links);
                        });
                    },
                },

                openLinksInNewWindow = function (links) {
                    chrome.runtime.sendMessage({
                        msg: 'openLinksInNewWindow',
                        links: links,
                    });
                    window.close();
                },

                openLinksInCurrentWindow = function (links) {
                    chrome.runtime.sendMessage({
                        msg: 'openLinksInCurrentWindow',
                        links: links,
                    });
                },

                openWindowLinksInCurrentWindow = function (links, window_id) {
                    chrome.runtime.sendMessage({
                        msg: 'openWindowLinksInCurrentWindow',
                        links: links,
                        window_id: window_id,
                    });
                },

                savedUI = {
                    groupHtmlElement: function (storage_name, group) {
                        var title = group.name;

                        if (group.name === '') {
                            title = utils.formatDate(new Date(parseInt(storage_name.slice('tg_'.length), 10)), storage_items.date_format);
                        }
                        return '<div id="' + utils.escapeHtml(storage_name) + '" class="group">' +
                            '<span class="spoiler" name="closed"> &#9658;</span>' +
                            '<span class="open_group">' + utils.escapeHtml(title) + '</span>' +
                            (group.synced === false ? this.notSyncedHtml() : '') +
                            '<span class="open_in_new_window" title="' + ui_msg.title_group_in_new_window + '">&#10064;</span> ' +
                            '<span class="group_action">' +
                            '<span class="add_link" title="' + ui_msg.title_add_link_to_group + '">&#10010;</span>' +
                            '<span class="up" title="' + ui_msg.title_up_link + '">&#9650;</span>' +
                            '<span class="down" title="' + ui_msg.title_down_link + '">&#9660;</span>' +
                            '<span class="edit_group" title="' + ui_msg.title_edit_group_name + '">&#9776;</span>' +
                            '<span class="del_group" title="' + ui_msg.title_del_group + '">&#10006;</span>' +
                            '</span>' +
                            '</div>';
                    },

                    notSyncedHtml: function () {
                        return '<span class="not_synced" title="' + ui_msg.not_synced + '">&#9888;</span>';
                    },

                    // show or hide the "not synced" mark of a group that is on the screen
                    setSyncMark: function (storage_name, synced) {
                        var group_node = document.getElementById(storage_name),
                            mark = group_node && group_node.querySelector('.not_synced');

                        if (!group_node) {
                            return;
                        }
                        if (synced && mark) {
                            mark.remove();
                        } else if (!synced && !mark) {
                            group_node.querySelector('.open_group').insertAdjacentHTML('afterend', this.notSyncedHtml());
                        }
                    },

                    // after saved groups are written: marks, a note when sync didn't take them, a refresh on a conflict
                    onSaved: function (results) {
                        var self = this,
                            note = '',
                            copied = false;

                        Object.keys(results).forEach(function (storage_name) {
                            var res = results[storage_name];

                            self.setSyncMark(storage_name, res.synced);
                            if (res.error) {
                                note = /QUOTA_BYTES|MAX_ITEMS/.test(res.error) ? ui_msg.saved_locally_full : ui_msg.saved_locally_later;
                            }
                            copied = copied || !!res.copy;
                        });
                        if (note) {
                            this.showErrorMsg(null, note);
                        }
                        if (copied) {
                            // edited on another computer too: both versions are now in the list
                            groupStoreClient.list().then(function (groups) {
                                groupModel.data_local_copy = groups;
                                self.showGroups();
                            });
                        }
                    },

                    linkHtmlElement: function (storage_name, link) {
                        var a_text = link.title,
                            a_title = '',
                            pin_icon = link.pinned ? '<img class="pinned_icon" src="img/pin-26.png">' : '',
                            favicon_src = faviconURL(link.url);

                        if (link.title.length >= TAB_TITLE_LENGTH) {
                            a_text = link.title.slice(0, TAB_TITLE_LENGTH) + '...';
                            a_title = 'title="' + utils.escapeHtml(link.title) + '"';
                        }
                        return '<div id="' + utils.escapeHtml(storage_name + '_' + link.id) + '" class="link">' +
                            '<span class="link_action">' +
                            '<span class="edit_link" title="' + ui_msg.title_edit_link + '">&#9776;</span>' +
                            '<span class="del_link" title="' + ui_msg.title_del_link + '">&#10006;</span>' +
                            '<a href="' + utils.escapeHtml(link.url) + '" target="_blank" ' + a_title + '>' +
                            '<span class="favi" title="' + utils.escapeHtml(link.url) + '"><img src="' + utils.escapeHtml(favicon_src) + '"></span>' +
                            pin_icon + utils.escapeHtml(a_text) + '</a>' +
                            '</span>' +
                            '</div>';
                    },

                    openGroup: function (storage_name, mouse_button) {
                        // mouse_button = 0  - cur window, 1 - new
                        var tabs = (groupModel.getGroups())[storage_name].tabs;

                        if (mouse_button === 1) {
                            openLinksInNewWindow(tabs);
                        } else {
                            openLinksInCurrentWindow(tabs);
                            //tabs.forEach(function (el) {
                            //    chrome.tabs.create({'url': el.url, 'pinned': el.pinned});
                            //});
                        }
                    },

                    showGroups: function () {
                        var html = '<section id="error_msg"></section>',
                            self = this,
                            groups = groupModel.getGroups(),
                            tag = document.getElementById('saved'),
                            sorted_group_list = Object.keys(groups).sort(function (a, b) {
                                return groups[b].index - groups[a].index;
                            });
                        sorted_group_list.forEach(function (el) {
                            html += self.groupHtmlElement(el, groups[el]);
                        });
                        tag.innerHTML = html;
                        this.showSyncStorageUsage();
                    },

                    addGroup: function () {
                        var input_field = document.getElementById('new_group_name'),
                            name = input_field.value,
                            popup,
                            storage_name = groupModel.getStorageNameByName(name),
                            stored_group,
                            self = this;

                        tabsGrabber.collectTabs(function (tabs) {
                            if (!tabs.length) {
                                // e.g. only pinned tabs are open and they are not saved (see settings)
                                self.showErrorMsg(null, ui_msg.nothing_to_save);
                                return;
                            }
                            // check if group name already exist
                            if (storage_name !== false && name !== '') {
                                // group with the same name already exist
                                // show Popup with dialog
                                popup = new Popup('overwrite_group', function (data) {
                                    input_field.value = '';
                                    stored_group = groupModel.getGroups()[storage_name];
                                    stored_group.tabs = tabs;
                                    groupModel.upd(storage_name, stored_group, function (answ) {
                                        var group_node = document.getElementById(storage_name);

                                        if (answ.err === 0) {
                                            if (group_node && group_node.getElementsByClassName('links').length) {
                                                self.hideGroupLinks(group_node);
                                                self.showGroupLinks(storage_name, group_node);
                                            }
                                            self.showSyncStorageUsage();
                                        } else {
                                            self.showErrorMsg(answ.msg);
                                        }
                                    });
                                });
                            } else {
                                // new group name
                                input_field.value = '';
                                groupModel.add(name, tabs, function (answ) {
                                    if (answ.err === 0) {
                                        self.showSyncStorageUsage();
                                        // on top of the list, right after the message area
                                        document.getElementById('error_msg')
                                            .insertAdjacentHTML('afterend', self.groupHtmlElement(answ.storage_name, answ.new_group));
                                    } else {
                                        // storage Error
                                        self.showErrorMsg(answ.msg);
                                    }
                                });
                            }
                        });
                    },

                    editGroupName: function (storage_name, el) {
                        var group = (groupModel.getGroups())[storage_name],
                            new_name,
                            popup,
                            self = this;

                        document.getElementById('popup-new_group_name').value = group.name;
                        popup = new Popup('edit_group_name', function (data) {
                            new_name = data['popup-new_group_name'];
                            if (new_name !== undefined && new_name !== '') {
                                group.name = new_name;
                                groupModel.upd(storage_name, group, function (answ) {
                                    if (answ.err === 0) {
                                        el.getElementsByClassName('open_group')[0].innerText = new_name;
                                        self.showSyncStorageUsage();
                                    } else {
                                        self.showErrorMsg(answ.msg);
                                    }
                                });
                            }

                        });
                    },

                    delGroup: function (storage_name, el) {
                        var self = this,
                            group = groupModel.getGroups()[storage_name];

                        groupModel.del(storage_name, function (answ) {
                            if (answ.err === 0) {
                                el.remove();
                                self.showSyncStorageUsage();
                                self.showUndo(storage_name, group);
                            } else {
                                self.showErrorMsg(answ.msg);
                            }
                        });
                    },

                    // the last deleted group can be brought back for a few seconds
                    showUndo: function (storage_name, group) {
                        var self = this,
                            bar = document.getElementById('undo_bar');

                        clearTimeout(this.undo_timer);
                        bar.style.display = 'block';
                        bar.getElementsByClassName('undo')[0].onclick = function (e) {
                            var results = {};

                            e.preventDefault();
                            clearTimeout(self.undo_timer);
                            bar.style.display = 'none';
                            groupStoreClient.restore(storage_name).then(function (res) {
                                group.synced = res.synced;
                                groupModel.data_local_copy[storage_name] = group;
                                self.showGroups();
                                results[storage_name] = res;
                                self.onSaved(results);
                            }, function (err) {
                                self.showErrorMsg(err.message);
                            });
                        };
                        this.undo_timer = setTimeout(function () {
                            bar.style.display = 'none';
                        }, 6000);
                    },

                    moveGroup: function (storage_name, sibling_storage_name) {
                        var self = this;

                        groupModel.move(storage_name, sibling_storage_name, function (answ) {
                            if (answ.err === 0) {
                                self.showGroups();
                            } else {
                                self.showErrorMsg(answ.msg);
                            }
                        });
                    },

                    showGroupLinks: function (storage_name, el) {
                        var link_list = document.createElement('div'),
                            spoiler = el.getElementsByClassName('spoiler')[0],
                            html = '',
                            self = this;

                        (groupModel.getGroups())[storage_name].tabs.forEach(function (el) {
                            html += self.linkHtmlElement(storage_name, el);
                        });
                        link_list.classList.add('links');
                        link_list.innerHTML = html;
                        el.insertBefore(link_list, null);
                        spoiler.setAttribute('name', 'opened');
                        spoiler.innerHTML = ' &#9660;';
                    },

                    hideGroupLinks: function (el) {
                        var spoiler = el.getElementsByClassName('spoiler')[0];

                        spoiler.setAttribute('name', 'closed');
                        spoiler.innerHTML = ' &#9658;';
                        el.getElementsByClassName('links')[0].remove();
                    },

                    delLink: function (storage_name, link_id, el) {
                        linkModel.del(storage_name, link_id, function (answ) {
                            if (answ.err === 0) {
                                el.remove();
                            }
                        });
                    },

                    addLink: function (storage_name, el) {
                        var self = this,
                            popup = new Popup('add_link', function (data) {
                                var obj = {
                                    id: linkModel.nextIndex(storage_name),
                                    title: data['popup-add_link_name'],
                                    url: utils.correctUrl(data['popup-add_link_link']),
                                };
                                linkModel.add(storage_name, obj, function (answ) {
                                    if (answ.err === 0) {
                                        var links_div = el.getElementsByClassName('links');
                                        if (links_div.length) {
                                            self.hideGroupLinks(el);
                                        }
                                        self.showGroupLinks(storage_name, el);
                                        self.showSyncStorageUsage();
                                    } else {
                                        self.showErrorMsg(answ.msg);
                                    }
                                });
                            });
                    },

                    editLink: function (storage_name, link_id, el) {
                        var group_node = el.parentNode.parentNode,
                            tabs = (groupModel.getGroups())[storage_name].tabs,
                            link_index = linkModel.getLocalLinkIndexById(storage_name, link_id),
                            popup,
                            self = this;

                        document.getElementById('popup-edit_link_name').value = tabs[link_index].title;
                        document.getElementById('popup-edit_link_url').value = tabs[link_index].url;
                        popup = new Popup('edit_link', function (data) {
                            var link_data = tabs[link_index];
                            link_data.title = data['popup-edit_link_name'];
                            link_data.url = utils.correctUrl(data['popup-edit_link_url']);
                            linkModel.upd(storage_name, link_index, link_data, function (answ) {
                                if (answ.err === 0) {
                                    self.hideGroupLinks(group_node);
                                    self.showGroupLinks(storage_name, group_node);
                                    self.showSyncStorageUsage();
                                } else {
                                    self.showErrorMsg(answ.msg);
                                }
                            });
                        });
                    },

                    // text: shown as is. Without it, msg is an error: a general message is shown, msg goes to the console.
                    // (Sync storage problems don't fail a save, so there is nothing more specific to say.)
                    showErrorMsg: function (msg, text) {
                        var el = document.getElementById('error_msg');

                        el.style.display = 'block';
                        if (!text) {
                            text = ui_msg.error_default;
                            if (msg) {
                                console.error('TabHamster:', msg);
                            }
                        }
                        el.innerText = text;
                        setTimeout(function () {
                            el.style.display = 'none';
                        }, 4581);
                    },

                    showSyncStorageUsage: function () {
                        groupStoreClient.usage().then(function (usage) {
                            var percent_in_use = (usage.bytes * 100 / usage.quota).toFixed(2),
                                el = document.querySelector('ul.tabs_nav>li a'),
                                text = el.innerText,
                                not_synced = usage.unsynced ?
                                    ', ' + chrome.i18n.getMessage('p_notSyncedCount', [String(usage.unsynced)]) : '';

                            el.innerText = text.slice(0, text.indexOf('|')) + '| ' + percent_in_use + '%' + not_synced;
                        });
                    },

                    setHandlers: function () {
                        var self = this,
                            saved = document.getElementById('saved');

                        document.getElementById('new_group').addEventListener('click', function (e) {
                            e.preventDefault();
                            self.addGroup();
                        }, false);

                        document.getElementById('new_group_name').addEventListener('keyup', function (e) {
                            if (e.keyCode === 13) {
                                self.addGroup();
                            }
                        }, false);

                        saved.addEventListener('click', function (e) {
                            var el = e.target,
                                group_node,
                                link_node,
                                btn,
                                sibling,
                                link;

                            function linkInfo(link_node_id) {
                                return {
                                    storage_name: link_node_id.slice(0, link_node_id.lastIndexOf('_')),
                                    id: link_node_id.slice(link_node_id.lastIndexOf('_') + 1),
                                };
                            }

                            e.stopPropagation();
                            switch (el.className) {
                                case 'open_group':
                                    // e.button - 0 - left mouse click (cur win), 1 - mouse wheel click (new win)
                                    // mouse wheel works only with no scroll
                                    btn = e.button;
                                    if (btn === 0 && e.ctrlKey === true) {
                                        self.openGroup(el.parentNode.id, 1);
                                    } else {
                                        self.openGroup(el.parentNode.id, e.button);
                                    }
                                    break;
                                case 'open_in_new_window':
                                    // e.button - 0 - left mouse click (cur win), 1 - mouse wheel click (new win)
                                    self.openGroup(el.parentNode.id, 1);
                                    break;
                                case 'up':
                                    group_node = el.parentNode.parentNode;
                                    sibling = group_node.previousSibling;
                                    if (sibling && sibling.className === 'group') {
                                        self.moveGroup(group_node.id, sibling.id);
                                    }
                                    break;
                                case 'down':
                                    group_node = el.parentNode.parentNode;
                                    sibling = group_node.nextSibling;
                                    if (sibling && sibling.className === 'group') {
                                        self.moveGroup(group_node.id, sibling.id);
                                    }
                                    break;
                                case 'del_group':
                                    group_node = el.parentNode.parentNode;
                                    self.delGroup(group_node.id, group_node);
                                    break;
                                case 'edit_group':
                                    group_node = el.parentNode.parentNode;
                                    self.editGroupName(group_node.id, group_node);
                                    break;
                                case 'add_link':
                                    group_node = el.parentNode.parentNode;
                                    self.addLink(group_node.id, group_node);
                                    break;
                                case 'spoiler':
                                    group_node = el.parentNode;
                                    if (el.getAttribute('name') === 'closed') {
                                        self.showGroupLinks(group_node.id, group_node);
                                    } else {
                                        self.hideGroupLinks(group_node);
                                    }
                                    break;
                                case 'del_link':
                                    link_node = el.parentNode.parentNode;
                                    link = linkInfo(link_node.id);
                                    self.delLink(link.storage_name, link.id, link_node);
                                    break;
                                case 'edit_link':
                                    link_node = el.parentNode.parentNode;
                                    link = linkInfo(link_node.id);
                                    self.editLink(link.storage_name, link.id, link_node);
                                    break;
                            }

                        }, false);

                    },

                    go: function () {
                        groupModel.onSaved = this.onSaved.bind(this);
                        this.showGroups();
                        this.setHandlers();
                    },
                },


                sessionsUI = {
                    groupHtmlElement: function (storage_name, group) {
                        var title,
                            date = utils.formatDate(new Date(parseInt(storage_name.slice('tg_'.length), 10)), storage_items.date_format),
                            group_info = (function () {
                                return {
                                    numbers_of_windows: sessionLinkModel.groupLinksByWindowId(storage_name).windowId_arr.length,
                                    numbers_of_tabs: (sessionModel.getGroups())[storage_name].tabs.length,
                                };
                            }());

                        if (group.name === '') {
                            title = date;
                        }
                        if (storage_name === session_storage_items.session_id) {
                            title = ui_msg.current_session + ' (' + date + ')';
                        }
                        return '<div id="' + utils.escapeHtml(storage_name) + '" class="group">' +
                            '<span class="spoiler" name="closed"> &#9658;</span>' +
                            '<span class="open_group">' + utils.escapeHtml(title) + '</span>' +
                            '<span class="open_in_new_window" title="' + ui_msg.title_group_in_new_window + '">&#10064;</span> ' +
                            '<span class="numbers_of_windows">' + ui_msg.windows_numbers + ' ' + group_info.numbers_of_windows + '</span>' +
                            '<span class="numbers_of_tabs">' + ui_msg.tabs_numbers + ' ' + group_info.numbers_of_tabs + '</span>' +
                            '<span class="group_action">' +
                            '<span class="del_group" title="' + ui_msg.title_del_group + '">&#10006;</span>' +
                            '</span>' +
                            '</div>';
                    },

                    linkHtmlElement: function (storage_name, link) {
                        var a_text = link.title,
                            a_title = '',
                            text_length = 44,
                            pin_icon = link.pinned === true ? '<img class="pinned_icon" src="img/pin-26.png">' : '',
                            favicon_src = faviconURL(link.url);

                        if (link.title.length > text_length) {
                            a_text = link.title.slice(0, text_length) + '...';
                            a_title = 'title="' + utils.escapeHtml(link.title) + '"';
                        }
                        return '<div class="link">' +
                            '<span class="link_action">' +
                            //                        '<span class="del_link" title="' + ui_msg.title_del_link + '">&#10006;</span>' +
                            '<a href="' + utils.escapeHtml(link.url) + '" target="_blank" ' + a_title + '>' +
                            '<span class="favi" title="' + utils.escapeHtml(link.url) + '"><img src="' + utils.escapeHtml(favicon_src) + '"></span>' +
                            pin_icon + utils.escapeHtml(a_text) + '</a>' +
                            '</span>' +
                            '</div>';
                    },

                    openGroup: function (storage_name, mouse_button) {
                        // mouse_button = 0  - cur window, 1 - new
                        var grouped,
                            links = [];

                        if (mouse_button === 1) {
                            grouped = sessionLinkModel.groupLinksByWindowId(storage_name);
                            grouped.windowId_arr.forEach(function (el, index) {
                                links = [];
                                grouped.grouped_by_windowId[index].forEach(function (link) {
                                    links.push(link);
                                });
                                openLinksInNewWindow(links);
                            });
                        } else {
                            openLinksInCurrentWindow((sessionModel.getGroups())[storage_name].tabs);
                            //(sessionModel.getGroups())[storage_name].tabs.forEach(function (el) {
                            //    chrome.tabs.create({'url': el.url, 'pinned': el.pinned});
                            //});
                        }
                    },

                    openWindow: function (storage_name, window_id, mouse_button) {
                        // mouse_button = 0  - cur window, 1 - new
                        var tabs = (sessionModel.getGroups())[storage_name].tabs,
                            links = [];

                        if (mouse_button === 1) {
                            tabs.forEach(function (el) {
                                if (el.windowId === parseInt(window_id, 10)) {
                                    links.push(el);
                                }
                            });
                            openLinksInNewWindow(links);
                        } else {
                            openWindowLinksInCurrentWindow(tabs, window_id);
                            //tabs.forEach(function (el) {
                            //    if (el.windowId === parseInt(window_id, 10)) {
                            //        chrome.tabs.create({'url': el.url, 'pinned': el.pinned});
                            //    }
                            //});
                        }
                    },

                    showGroups: function () {
                        var html = '<section id="sessions_error_msg"></section>',
                            groups = sessionModel.getGroups(),
                            self = this,
                            tag = document.getElementById('sessions'),
                            sorted_names_list = Object.keys(groups).sort(function (a, b) {
                                return parseInt(b.slice('tg_'.length), 10) - parseInt(a.slice('tg_'.length), 10);
                            });
                        sorted_names_list.forEach(function (el) {
                            html += self.groupHtmlElement(el, groups[el]);
                        });
                        tag.innerHTML = html;
                    },

                    delGroup: function (storage_name, el) {
                        var self = this;

                        sessionModel.del(storage_name, function (answ) {
                            if (answ.err === 0) {
                                el.remove();
                            } else {
                                self.showErrorMsg(answ.msg);
                            }
                        });
                    },

                    showGroupLinks: function (storage_name, el) {
                        var link_list = document.createElement('div'),
                            spoiler = el.getElementsByClassName('spoiler')[0],
                            html = '',
                            self = this,
                            grouped_links = sessionLinkModel.groupLinksByWindowId(storage_name);

                        grouped_links.grouped_by_windowId.forEach(function (link_arr, ind) {
                            var win_html = '<div class="win">' +
                                '<div class="win_title" id="' + utils.escapeHtml(storage_name + '_' + grouped_links.windowId_arr[ind]) + '">&#9642; ' + ui_msg.window_text + ' ' + (ind + 1) + '</div>';

                            link_arr.forEach(function (link) {
                                win_html += self.linkHtmlElement(storage_name, link);
                            });
                            win_html += '</div>';
                            html += win_html;
                        });
                        link_list.classList.add('links');
                        link_list.innerHTML = html;
                        el.insertBefore(link_list, null);
                        spoiler.setAttribute('name', 'opened');
                        spoiler.innerHTML = ' &#9660;';
                    },

                    hideGroupLinks: function (el) {
                        var spoiler = el.getElementsByClassName('spoiler')[0];

                        spoiler.setAttribute('name', 'closed');
                        spoiler.innerHTML = ' &#9658;';
                        el.getElementsByClassName('links')[0].remove();
                    },
                    setHandlers: function () {
                        var self = this;

                        document.getElementById('sessions').addEventListener('click', function (e) {
                            var el = e.target,
                                group_node,
                                btn,
                                win_info;

                            e.stopPropagation();
                            switch (el.className) {
                                case 'del_group':
                                    group_node = el.parentNode.parentNode;
                                    self.delGroup(group_node.id, group_node);
                                    break;
                                case 'spoiler':
                                    group_node = el.parentNode;
                                    if (el.getAttribute('name') === 'closed') {
                                        self.showGroupLinks(group_node.id, group_node);
                                    } else {
                                        self.hideGroupLinks(group_node);
                                    }
                                    break;
                                case 'open_group':
                                    // e.button - 0 - left mouse click (cur win), 1 - mouse wheel click (new win)
                                    // mouse wheel works only with no scroll
                                    btn = e.button;
                                    if (btn === 0 && e.ctrlKey === true) {
                                        self.openGroup(el.parentNode.id, 1);
                                    } else {
                                        self.openGroup(el.parentNode.id, e.button);
                                    }
                                    break;
                                case 'open_in_new_window':
                                    // e.button - 0 - left mouse click (cur win), 1 - mouse wheel click (new win)
                                    self.openGroup(el.parentNode.id, 1);
                                    break;
                                case 'win_title':
                                    // e.button - 0 - left mouse click (cur win), 1 - mouse wheel click (new win)
                                    // mouse wheel works only with no scroll
                                    btn = e.button;
                                    win_info = (function () {
                                        var win_id_start = el.id.lastIndexOf('_');
                                        return {
                                            storage_name: el.id.slice(0, win_id_start),
                                            window_id: el.id.slice(win_id_start + 1),
                                        };
                                    }());
                                    if (btn === 0 && e.ctrlKey === true) {
                                        self.openWindow(win_info.storage_name, win_info.window_id, 1);
                                    } else {
                                        self.openWindow(win_info.storage_name, win_info.window_id, 0);
                                    }
                                    break;
                            }

                        }, false);
                    },

                    go: function () {
                        this.showGroups();
                        this.setHandlers();
                    },
                },

//            mainUI = {
//                setHandlers: function () {
//                    document.body.onkeyup = function (e) {
//                        if (e.keyCode === 78 && e.target.tagName !== 'input') {
//                            alert(e.target.tagName);
//                        }
//                    };
//                }
//            },

                navigation;

            /* window tab navigation */
            navigation = new Tabs('#main_tabs');
            navigation.toggle(storage_items.active_tab);
            navigation.onToggle(function (tab_name) {
                chrome.storage.sync.set({active_tab: tab_name});
            });
            /* popup tab END */

            if (storage_items.session_watcher) {
                sessionsUI.go();
            } else {
                navigation.toggle('#saved');
                // hide session tab
                document.querySelector('.tabs_nav').querySelector('[href="#sessions"]').parentNode.style.display = 'none';
            }
            savedUI.go();
            if (list_error) {
                savedUI.showErrorMsg(list_error.message);
            }
            document.getElementById('new_group_name').removeEventListener('keyup', onEarlyEnter, false);
            if (enter_pressed_early) {
                savedUI.addGroup();
            }
//          mainUI.setHandlers();
        }, function () {
            // can't read sync storage (options)
            document.getElementById('saved').innerText = chrome.i18n.getMessage('p_syncStorageDefault_error');
        });
    });
});
// TODO blink group el after create, move
// TODO hоt keys
