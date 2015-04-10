var utils = {
    formatDate: function (date, date_format) {
        var res,
            day = plusZero(date.getDate()),
            month = plusZero(date.getMonth() + 1),
            year = date.getFullYear(),
            hours = plusZero(date.getHours()),
            minutes = plusZero(date.getMinutes());

        function plusZero(d) {
            return (d.toString()).length === 2 ? d : '0' + d;
        }

        switch (date_format) {
            case 'eu':
                res = day + '-' + month + '-' + year + ' ' + hours + ':' + minutes;
                break;
            case 'us':
                res = year + '-' + month + '-' + day + ' ' + hours + ':' + minutes;
                break;
        }
        return res;
    },

    correctUrl: function (url) {
        var start_with = ['http://', 'https://', 'ftp://', 'opera://', 'chrome://', 'chrome-extension://', 'chrome-devtools://', 'file://'];
        return start_with.some(function (el) {
            return (url.indexOf(el) === 0);
        }) ? url : 'http://' + url;
    }
};
