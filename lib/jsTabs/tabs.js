/**
 * jsTabs. No jQuery. IE 10+
 * https://github.com/onikienko/jsTabs
 *
 * @param {string} tabs_id  ID of Tabs container with #
 * @param {function|object} [handlers] onToggle handlers
 * @constructor
 */
function Tabs(tabs_id, handlers) {
    this.html = document.querySelector(tabs_id);
    this.nav_links = this.html.querySelectorAll('.tabs_nav li a');
    this.ontoggle_handlers_list = {};

    var self = this;
    this.nav_links_array = (function () {
        var arr = [];
        [].forEach.call(self.nav_links, function (el) {
            arr.push(el.hash);
        });
        return arr;
    }());
    if (handlers) {
        this.onToggle(handlers);
    }
    this.go_();
}

Tabs.prototype = {
    fireOnToggle_: function (tab_name) {
        if (this.ontoggle_handlers_list.hasOwnProperty(tab_name) && this.ontoggle_handlers_list[tab_name].length > 0) {
            this.ontoggle_handlers_list[tab_name].forEach(function (handler) {
                handler(tab_name);
            });
        }
    },

    toggle: function (tab_name) {
        if (tab_name && this.nav_links_array.indexOf(tab_name) !== -1) {
            [].forEach.call(this.html.querySelectorAll('.tabs_content>div'), function (el) {
                el.style.display = ('#' + el.id === tab_name) ? 'block' : 'none';
            });
            [].forEach.call(this.nav_links, function (el) {
                if (el.hash === tab_name) {
                    el.parentNode.classList.add('active');
                } else {
                    el.parentNode.classList.remove('active');
                }
            });
            this.fireOnToggle_(tab_name);
        }
    },

    /**
     *
     * @param {function|object} handlers {'#tab_name': handler_function} or a single function to bind it on every toggle
     */
    onToggle: function (handlers) {
        var tab,
            self = this;

        function addHandler(tab_name, handler) {
            if (!self.ontoggle_handlers_list[tab_name]) {
                self.ontoggle_handlers_list[tab_name] = [];
            }
            self.ontoggle_handlers_list[tab_name].push(handler);
        }

        if (typeof handlers === 'function') {
            this.nav_links_array.forEach(function (el) {
                addHandler(el, handlers);
            });
        } else if (typeof handlers === 'object') {
            for (tab in handlers) {
                if (this.nav_links_array.indexOf(tab) !== -1) {
                    addHandler(tab, handlers[tab]);
                }
            }
        }
    },

    onNavClick_: function () {
        var self = this;
        self.html.querySelector('.tabs_nav').addEventListener('click', function (e) {
            var hash = e.target.hash,
                li;
            if (!hash) {
                if (e.target.tagName === 'LI') {
                    li = e.target.querySelector('a');
                    hash = li.hash;
                }
            }
            if (hash && self.nav_links_array.indexOf(hash) !== -1 && !e.target.parentElement.classList.contains('active')) {
                self.toggle(hash);
            }
            e.preventDefault();
            e.stopPropagation();
        }, false);
    },

    go_: function () {
        if (this.nav_links_array.length > 0) {
            var hash = window.location.hash;
            if (!hash || this.nav_links_array.indexOf(hash) === -1) {
                hash = this.nav_links[0].hash;
            }
            this.toggle(hash);
            this.onNavClick_();
        }
    }
};
