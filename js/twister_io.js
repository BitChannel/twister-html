// twister_io.js
// 2013 Miguel Freitas
//
// low-level twister i/o.
// implements requests of dht resources. multiple pending requests to the same resource are joined.
// cache results (profile, avatar, etc) in memory.
// avatars are cached in localstored (expiration = 24 hours)

// main json rpc method. receives callbacks for success and error
function twisterRpc(method, params, resultFunc, resultArg, errorFunc, errorArg) {
    // removing hardcoded username from javascript: please use url http://user:pwd@localhost:28332 instead
    //var foo = new $.JsonRpcClient({ ajaxUrl: '/', username: 'user', password: 'pwd'});
    var foo = new $.JsonRpcClient({ ajaxUrl: window.location.pathname.replace(/[^\/]*$/, '') });
    foo.call(method, params,
        function(ret) { resultFunc(resultArg, ret); },
        function(ret) { if(ret != null) errorFunc(errorArg, ret); }
    );
}

// join multiple dhtgets to the same resources in this map
var _dhtgetPendingMap = {};

// memory cache for profile and avatar
var _profileMap = {};
var _avatarMap = {};
var _pubkeyMap = {};

// number of dhtgets in progress (requests to the daemon)
var _dhtgetsInProgress = 0;

// keep _maxDhtgets smaller than the number of daemon/browser sockets
// most browsers limit to 6 per domain (see http://www.browserscope.org/?category=network)
var _maxDhtgets = 5;

// requests not yet sent to the daemon due to _maxDhtgets limit
var _queuedDhtgets = [];

// private function to define a key in _dhtgetPendingMap
function _dhtgetLocator(username, resource, multi) {
    return username+";"+resource+";"+multi;
}

function _dhtgetAddPending(locator, cbFunc, cbArg)
{
    if( !(locator in _dhtgetPendingMap) ) {
        _dhtgetPendingMap[locator] = [];
    }
    _dhtgetPendingMap[locator].push( {cbFunc:cbFunc, cbArg:cbArg} );
}

function _dhtgetProcessPending(locator, multi, ret)
{
    if( locator in _dhtgetPendingMap ) {
        for( var i = 0; i < _dhtgetPendingMap[locator].length; i++) {
            var cbFunc = _dhtgetPendingMap[locator][i].cbFunc;
            var cbArg  = _dhtgetPendingMap[locator][i].cbArg;

            if( multi == 's' ) {
                if( ret[0] != undefined ) {
                     cbFunc(cbArg, ret[0]["p"]["v"], ret);
                } else {
                     cbFunc(cbArg, null);
                }
            } else {
                var multiret = [];
                for (var j = 0; j < ret.length; j++) {
                    multiret.push(ret[j]["p"]["v"]);
                }
                cbFunc(cbArg, multiret, ret);
            }
        }
        delete _dhtgetPendingMap[locator];
    } else {
        console.log("warning: _dhtgetProcessPending with unknown locator "+locator);
    }
}

function _dhtgetAbortPending(locator)
{
    if( locator in _dhtgetPendingMap ) {
        for( var i = 0; i < _dhtgetPendingMap[locator].length; i++) {
            var cbFunc = _dhtgetPendingMap[locator][i].cbFunc;
            var cbArg  = _dhtgetPendingMap[locator][i].cbArg;
            cbFunc(cbArg, null);
        }
        delete _dhtgetPendingMap[locator];
    } else {
        console.log("warning: _dhtgetAbortPending with unknown locator "+locator);
    }
}

// get data from dht resource
// the value ["v"] is extracted from response and returned to callback
// null is passed to callback in case of an error
function dhtget( username, resource, multi, cbFunc, cbArg, timeoutArgs ) {
    //console.log('dhtget '+username+' '+resource+' '+multi);
    var locator = _dhtgetLocator(username, resource, multi);
    if( locator in _dhtgetPendingMap) {
        _dhtgetAddPending(locator, cbFunc, cbArg);
    } else {
        _dhtgetAddPending(locator, cbFunc, cbArg);
        // limit the number of simultaneous dhtgets.
        // this should leave some sockets for other non-blocking daemon requests.
        if( _dhtgetsInProgress < _maxDhtgets ) {
            _dhtgetInternal( username, resource, multi, timeoutArgs );
        } else {
            // just queue the locator. it will be unqueue when some dhtget completes.
            _queuedDhtgets.push(locator);
        }
    }
}

function _dhtgetInternal( username, resource, multi, timeoutArgs ) {
    var locator = _dhtgetLocator(username, resource, multi);
    _dhtgetsInProgress++;
    argsList = [username,resource,multi];
    if( typeof timeoutArgs !== 'undefined' ) {
        argsList = argsList.concat(timeoutArgs);
    }
    twisterRpc("dhtget", argsList,
               function(args, ret) {
                   _dhtgetsInProgress--;
                   _dhtgetProcessPending(args.locator, args.multi, ret);
                   _dhtgetDequeue();
               }, {locator:locator,multi:multi},
               function(cbArg, ret) {
                   console.log("ajax error:" + ret);
                   _dhtgetsInProgress--;
                   _dhtgetAbortPending(locator);
                   _dhtgetDequeue();
               }, locator);
}

function _dhtgetDequeue() {
    if( _queuedDhtgets.length ) {
        var locatorSplit = _queuedDhtgets.pop().split(";");
        _dhtgetInternal(locatorSplit[0], locatorSplit[1], locatorSplit[2]);
    }
}

// removes queued dhtgets (requests that have not been made to the daemon)
// this is used by user search dropdown to discard old users we are not interested anymore
function removeUserFromDhtgetQueue(username) {
    var resources = ["profile","avatar"]
    for (var i = 0; i < resources.length; i++) {
        var locator = _dhtgetLocator(username,resources[i],"s");
        var locatorIndex = _queuedDhtgets.indexOf(locator);
        if( locatorIndex > -1 ) {
            _queuedDhtgets.splice(locatorIndex,1);
            delete _dhtgetPendingMap[locator];
        }
    }
}

function removeUsersFromDhtgetQueue(users) {
    for (var i = 0; i < users.length; i++ ) {
        removeUserFromDhtgetQueue( users[i] );
    }
}

// store value at the dht resource
function dhtput( username, resource, multi, value, sig_user, seq, cbFunc, cbArg ) {
    twisterRpc("dhtput", [username,resource,multi, value, sig_user, seq],
               function(args, ret) {
                   if( args.cbFunc )
                       args.cbFunc(args.cbArg, true);
               }, {cbFunc:cbFunc, cbArg:cbArg},
               function(args, ret) {
                   console.log("ajax error:" + ret);
                   if( args.cbFunc )
                       args.cbFunc(args.cbArg, false);
               }, cbArg);
}

// get something from profile and store it in item.text or do callback
function getProfileResource( username, resource, item, cbFunc, cbArg ){
    var profile = undefined;
    if( username in _profileMap ) {
        profile = _profileMap[username];
    } else {
        profile = _getResourceFromStorage("profile:" + username);
    }
    if( profile ) {
        _profileMap[username] = profile;
        if( item )
            item.text(profile[resource]);
        if( cbFunc )
            cbFunc(cbArg, profile[resource]);
    } else {
        dhtget( username, "profile", "s",
               function(args, profile) {
                   if( profile ) {
                       _profileMap[args.username] = profile;
                       _putResourceIntoStorage("profile:" + username, profile);
                       if( args.item )
                           args.item.text(profile[resource]);
                       if( args.cbFunc )
                           args.cbFunc(args.cbArg, profile[resource]);
                   } else {
                       if( args.cbFunc )
                           args.cbFunc(args.cbArg, null);
                   }
               }, {username:username,item:item,cbFunc:cbFunc,cbArg:cbArg});
    }
}

// get fullname and store it in elem.text
function getFullname(peerAlias, elem) {
    elem.text(peerAlias);  // fallback: set the peerAlias first in case the profile has no fullname
    getProfileResource(peerAlias, 'fullname', undefined,
        function(req, name) {
            if (name && (name = name.trim()))
                req.elem.text(name);

            if (typeof twisterFollowingO !== 'undefined' &&  // FIXME delete this check when you fix client init sequence
                ($.Options.isFollowingMe.val === 'everywhere' || req.elem.hasClass('profile-name'))) {
                // here we try to detect if peer follows us and then display it
                if (twisterFollowingO.knownFollowers.indexOf(req.peerAlias) > -1) {
                    req.elem.addClass('isFollowing');
                    req.elem.attr('title', polyglot.t('follows you'));
                } else if (twisterFollowingO.notFollowers.indexOf(req.peerAlias) === -1) {
                    if (twisterFollowingO.followingsFollowings[req.peerAlias] &&
                        twisterFollowingO.followingsFollowings[req.peerAlias].following) {
                        if (twisterFollowingO.followingsFollowings[req.peerAlias].following.indexOf(defaultScreenName) > -1) {
                            if (twisterFollowingO.knownFollowers.indexOf(req.peerAlias) === -1) {
                                twisterFollowingO.knownFollowers.push(req.peerAlias);
                                twisterFollowingO.save();
                                addPeerToFollowersList(getElem('.followers-modal .followers-list'), req.peerAlias, true);
                                $('.open-followers').attr('title', twisterFollowingO.knownFollowers.length.toString());
                            }
                            req.elem.addClass('isFollowing');
                            req.elem.attr('title', polyglot.t('follows you'));
                        }
                    } else {
                        loadFollowingFromDht(req.peerAlias, 1, [], 0,
                            function (req, following, seqNum) {
                                if (following.indexOf(defaultScreenName) > -1) {
                                    if (twisterFollowingO.knownFollowers.indexOf(req.peerAlias) === -1) {
                                        twisterFollowingO.knownFollowers.push(req.peerAlias);
                                        addPeerToFollowersList(getElem('.followers-modal .followers-list'), req.peerAlias, true);
                                        $('.open-followers').attr('title', twisterFollowingO.knownFollowers.length.toString());
                                    }
                                    req.elem.addClass('isFollowing');
                                    req.elem.attr('title', polyglot.t('follows you'));
                                } else if (twisterFollowingO.notFollowers.indexOf(req.peerAlias) === -1)
                                    twisterFollowingO.notFollowers.push(req.peerAlias);

                                twisterFollowingO.save();
                            }, {elem: req.elem, peerAlias: req.peerAlias}
                        );
                    }
                }
            }
        }, {elem: elem, peerAlias: peerAlias}
    );
}

// get bio, format it as post message and store result to elem
function getBioToElem(peerAlias, elem) {
    getProfileResource(peerAlias, 'bio', undefined, fillElemWithTxt, elem);
}

// get tox address and store it in item.text
function getTox( username, item ){
    getProfileResource( username, "tox", false, function(item, text){
        //item.empty();
        if(text) {
            item.attr('href', 'tox:'+text);
            item.next().attr('data', text).attr('title', 'Copy to clipboard');
            item.parent().css('display','inline-block').parent().show();
        }
    }, item);
}

// get bitmessage address and store it in item.text
function getBitmessage( username, item ){
    getProfileResource( username, "bitmessage", false, function(item, text){
        //item.empty();
        if(text) {
            item.attr('href', 'bitmsg:'+text+'?action=add&label='+username);
            item.next().attr('data', text).attr('title', 'Copy to clipboard');
            item.parent().css('display','inline-block').parent().show();
        }
    }, item);
}

// get location and store it in item.text
function getLocation( username, item ){
    getProfileResource( username, "location", item);
}

// get location and store it in item.text
function getWebpage( username, item ){
    getProfileResource( username, "url", item,
                      function(args, val) {
                          if(typeof(val) !== 'undefined') {
                              if (val.indexOf("://") < 0) {
                                  val = "http://" + val;
                              }
                              args.item.attr("href", val);
                          }
                      }, {item:item} );
}

function getGroupChatName( groupalias, item ){
    twisterRpc("getgroupinfo", [groupalias],
               function(args, ret) {
                   args.item.text(ret["description"]);
               }, {item:item},
               function(args, ret) {
                   args.item.text("getgroupinfo error");
               }, {item:item});
}

// we must cache avatar results to disk to lower bandwidth on
// other peers. dht server limits udp rate so requesting too much
// data will only cause new requests to fail.
function _getResourceFromStorage(locator) {
    var storage = $.localStorage;
    if (storage.isSet(locator)) {
        var storedResource = storage.get(locator);
        var curTime = new Date().getTime() / 1000;
        // avatar is downloaded once per day    FIXME why once per day? what about profiles?
        // FIXME need to check what type of data is requested and what time is allowed for it
        if (storedResource.time + 86400 > curTime) {  // 3600 * 24
            return storedResource.data;
        }
    }
    return null;
}

function _putResourceIntoStorage(locator, data) {
    $.localStorage.set(locator, {
        time: Math.trunc(new Date().getTime() / 1000),
        data: data
    });
}

function cleanupStorage() {
    var curTime = new Date().getTime() / 1000;
    var storage = $.localStorage, keys = storage.keys(), item = '';
    var delAvatars = delProfiles = 0;

    for (var i = 0; i < keys.length; i++) {
        item = keys[i];
        // FIXME need to decide what time for type of data is allowed
        if (item.substr(0, 7) === 'avatar:') {
            if (storage.get(item).time + 86400 < curTime) {  // 3600 * 24 hours
                storage.remove(item);
                delAvatars++;
                //console.log('local storage item \'' + item + '\' was too old, deleted');
            }
        } else if (item.substr(0, 8) === 'profile:') {
            if (storage.get(item).time + 86400 < curTime) {  // 3600 * 24 hours
                storage.remove(item);
                delProfiles++;
                //console.log('local storage item \'' + item + '\' was too old, deleted');
            }
        }
    }

    console.log('cleaning of storage is completed for ' + (new Date().getTime() / 1000 - curTime) + 's');
    if (delAvatars) console.log('  ' + delAvatars + ' cached avatars was too old, deleted');
    if (delProfiles) console.log('  ' + delProfiles + ' cached profiles was too old, deleted');
    console.log('  ' + 'there was ' + i + ' items in total, now ' + (i - delAvatars - delProfiles));
}

// get avatar and set it in img.attr("src")
// TODO rename to getAvatarImgToELem(), move nin theme related stuff to nin's theme_option.js
function getAvatar(username, img) {
    if (!img.length)
        return;

    if (username === 'nobody') {
        img.attr('src', ($.Options.theme.val === 'nin') ?
            'theme_nin/img/tornado_avatar.png' : 'img/tornado_avatar.png');
        return;
    }

    if (_avatarMap[username]) {
        //img.attr('src', 'data:image/jpg;base64,'+avatarMap[username]);
        img.attr('src', _avatarMap[username]);
    } else {
        var data = _getResourceFromStorage('avatar:' + username);

        if (data) {
            switch (data.substr(0, 4)) {
                case 'jpg/':
                    data = 'data:image/jpeg;base64,/9j/' + window.btoa(data.slice(4));
                    break;
                case 'png/':
                    data = 'data:image/png;base64,' + window.btoa(data.slice(4));
                    break;
                case 'gif/':
                    data = 'data:image/gif;base64,' + window.btoa(data.slice(4));
                    break;
            }
            _avatarMap[username] = data;
            img.attr('src', data);
        } else {
            dhtget(username, 'avatar', 's',
                function(req, imagedata) {
                    if (imagedata && imagedata.length) {
                        _avatarMap[req.username] = imagedata;
                        if (imagedata !== 'img/genericPerson.png') {
                            if (imagedata.substr(0, 27) === 'data:image/jpeg;base64,/9j/')
                                _putResourceIntoStorage('avatar:' + username, 'jpg/' + window.atob(imagedata.slice(27)));
                            else {
                                var s = imagedata.substr(0, 22);
                                if (s === 'data:image/png;base64,' || s === 'data:image/gif;base64,')
                                    _putResourceIntoStorage('avatar:' + username, imagedata.substr(11, 3) + '/' + window.atob(imagedata.slice(22)));
                                else
                                    _putResourceIntoStorage('avatar:' + username, imagedata);
                            }
                        }
                        req.img.attr('src', imagedata);
                    }
                }, {username: username, img: img}
            );
        }
    }
}

function clearAvatarAndProfileCache(username) {
    var storage = $.localStorage;
    storage.remove("avatar:" + username);
    storage.remove("profile:" + username);
    if( username in _avatarMap ) {
        delete _avatarMap[username];
    }
    if( username in _profileMap ) {
        delete _profileMap[username];
    }
}

// get estimative for number of followers (use known peers of torrent tracker)
function getFollowers( username, item ) {
    dhtget( username, "tracker", "m",
           function(args, ret) {
               if( ret && ret.length && ret[0]["followers"] ) {
                   args.item.text(ret[0]["followers"])
               }
           }, {username:username,item:item} );
}

function getPostsCount( username, item ) {
    dhtget( username, "status", "s",
           function(args, v) {
               var count = 0;
               if( v && v["userpost"] ) {
                   count = v["userpost"]["k"]+1;
               }
               var oldCount = parseInt(args.item.text());
               if( !oldCount || count > oldCount ) {
                   args.item.text(count);
               }
               if( username == defaultScreenName && count ) {
                   incLastPostId( v["userpost"]["k"] );
               }
           }, {username:username,item:item} );
}

function getPostMaxAvailability(username, k, cbFunc, cbArg) {
    twisterRpc("getpiecemaxseen", [username,k],
               function(args, ret) {
                   args.cbFunc(args.cbArg, ret);
               }, {cbFunc:cbFunc, cbArg:cbArg},
               function(args, ret) {
                   console.log("getPostAvailability error");
               }, {cbFunc:cbFunc, cbArg:cbArg});
}

function checkPubkeyExists(username, cbFunc, cbArg) {
    // pubkey is checked in block chain db.
    // so only accepted registrations are reported (local wallet users are not)
    twisterRpc("dumppubkey", [username],
               function(args, ret) {
                   args.cbFunc(args.cbArg, ret.length > 0);
               }, {cbFunc:cbFunc, cbArg:cbArg},
               function(args, ret) {
                   alert(polyglot.t("error_connecting_to_daemon"));
               }, {cbFunc:cbFunc, cbArg:cbArg});
}

// pubkey is obtained from block chain db.
// so only accepted registrations are reported (local wallet users are not)
// cbFunc is called as cbFunc(cbArg, pubkey)
// if user doesn't exist then pubkey.length == 0
function dumpPubkey(username, cbFunc, cbArg) {
    if( username in _pubkeyMap ) {
        if( cbFunc )
            cbFunc(cbArg, _pubkeyMap[username]);
    } else {
        twisterRpc("dumppubkey", [username],
                   function(args, ret) {
                       if( ret.length > 0 ) {
                            _pubkeyMap[username] = ret;
                       }
                       args.cbFunc(args.cbArg, ret);
                   }, {cbFunc:cbFunc, cbArg:cbArg},
                   function(args, ret) {
                       alert(polyglot.t("error_connecting_to_daemon"));
                   }, {cbFunc:cbFunc, cbArg:cbArg});
    }
}

// privkey is obtained from wallet db
// so privkey is returned even for unsent transactions
function dumpPrivkey(username, cbFunc, cbArg) {
    twisterRpc("dumpprivkey", [username],
               function(args, ret) {
                   args.cbFunc(args.cbArg, ret);
               }, {cbFunc:cbFunc, cbArg:cbArg},
               function(args, ret) {
                   args.cbFunc(args.cbArg, "");
                   console.log("dumpprivkey: user unknown");
               }, {cbFunc:cbFunc, cbArg:cbArg});
}

