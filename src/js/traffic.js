/*******************************************************************************

    µMatrix - a Chromium browser extension to black/white list requests.
    Copyright (C) 2014  Raymond Hill

    This program is free software: you can redistribute it and/or modify
    it under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

    This program is distributed in the hope that it will be useful,
    but WITHOUT ANY WARRANTY; without even the implied warranty of
    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
    GNU General Public License for more details.

    You should have received a copy of the GNU General Public License
    along with this program.  If not, see {http://www.gnu.org/licenses/}.

    Home: https://github.com/gorhill/uMatrix
*/

/* global chrome, µMatrix */
/* jshint boss: true */

/******************************************************************************/

// Start isolation from global scope

µMatrix.webRequest = (function() {

/******************************************************************************/

// Intercept and filter web requests according to white and black lists.

var onBeforeRootFrameRequestHandler = function(details) {
    var µm = µMatrix;
    var requestURL = details.url;
    var tabId = details.tabId;

    µm.tabContextManager.push(tabId, requestURL);

    var tabContext = µm.tabContextManager.mustLookup(tabId);
    var rootHostname = tabContext.rootHostname;
    var pageStore = µm.bindTabToPageStats(tabId);

    // Disallow request as per matrix?
    var block = µm.mustBlock(rootHostname, details.hostname, 'doc');

    pageStore.recordRequest('doc', requestURL, block);
    µm.logger.writeOne(tabId, 'net', rootHostname, requestURL, 'doc', block);

    // Not blocked
    if ( !block ) {
        // rhill 2013-11-07: Senseless to do this for behind-the-scene requests.
        µm.cookieHunter.recordPageCookies(pageStore);
        return;
    }

    // Blocked
    var query = btoa(JSON.stringify({
        url: requestURL,
        hn: details.hostname,
        why: '?'
    }));

    vAPI.tabs.replace(tabId, vAPI.getURL('main-blocked.html?details=') + query);

    return { cancel: true };
};

/******************************************************************************/

// Intercept and filter web requests according to white and black lists.

var onBeforeRequestHandler = function(details) {
    var µm = µMatrix;

    // rhill 2014-02-17: Ignore 'filesystem:': this can happen when listening
    // to 'chrome-extension://'.
    var requestScheme = µm.URI.schemeFromURI(details.url);
    if ( requestScheme === 'filesystem' ) {
        return;
    }

    // console.debug('onBeforeRequestHandler()> "%s": %o', details.url, details);

    var requestType = requestTypeNormalizer[details.type] || 'other';

    // https://github.com/gorhill/httpswitchboard/issues/303
    // Wherever the main doc comes from, create a receiver page URL: synthetize
    // one if needed.
    if ( requestType === 'doc' && details.parentFrameId < 0 ) {
        return onBeforeRootFrameRequestHandler(details);
    }

    var requestURL = details.url;

    // Ignore non-http schemes
    if ( requestScheme.lastIndexOf('http', 0) !== 0 ) {
        return;
    }

    // Re-classify orphan HTTP requests as behind-the-scene requests. There is
    // not much else which can be done, because there are URLs
    // which cannot be handled by µMatrix, i.e. `opera://startpage`,
    // as this would lead to complications with no obvious solution, like how
    // to scope on unknown scheme? Etc.
    // https://github.com/gorhill/httpswitchboard/issues/191
    // https://github.com/gorhill/httpswitchboard/issues/91#issuecomment-37180275
    var tabContext = µm.tabContextManager.mustLookup(details.tabId);
    var tabId = tabContext.tabId;
    var rootHostname = tabContext.rootHostname;

    // Enforce strict secure connection?
    var block = false;
    if (
        tabContext.secure &&
        µm.URI.isSecureScheme(requestScheme) === false &&
        µm.tMatrix.evaluateSwitchZ('https-strict', rootHostname)
    ) {
        block = true;
    }

    // Disallow request as per temporary matrix?
    if ( block === false ) {
        block = µm.mustBlock(rootHostname, details.hostname, requestType);
    }

    // Record request.
    // https://github.com/gorhill/httpswitchboard/issues/342
    // The way requests are handled now, it may happen at this point some
    // processing has already been performed, and that a synthetic URL has
    // been constructed for logging purpose. Use this synthetic URL if
    // it is available.
    var pageStore = µm.mustPageStoreFromTabId(tabId);
    pageStore.recordRequest(requestType, requestURL, block);
    µm.logger.writeOne(tabId, 'net', rootHostname, requestURL, requestType, block);

    // Allowed?
    if ( !block ) {
        // console.debug('onBeforeRequestHandler()> ALLOW "%s": %o', details.url, details);
        return;
    }

    // Blocked
    // console.debug('onBeforeRequestHandler()> BLOCK "%s": %o', details.url, details);

    return { 'cancel': true };
};

/******************************************************************************/

// Sanitize outgoing headers as per user settings.

var onBeforeSendHeadersHandler = function(details) {
    var µm = µMatrix;

    // console.debug('onBeforeSendHeadersHandler()> "%s": %o', details.url, details);

    // Re-classify orphan HTTP requests as behind-the-scene requests. There is
    // not much else which can be done, because there are URLs
    // which cannot be handled by HTTP Switchboard, i.e. `opera://startpage`,
    // as this would lead to complications with no obvious solution, like how
    // to scope on unknown scheme? Etc.
    // https://github.com/gorhill/httpswitchboard/issues/191
    // https://github.com/gorhill/httpswitchboard/issues/91#issuecomment-37180275
    var pageStore = µm.mustPageStoreFromTabId(details.tabId);
    var tabId = pageStore.tabId;

    // https://github.com/gorhill/httpswitchboard/issues/342
    // Is this hyperlink auditing?
    // If yes, create a synthetic URL for reporting hyperlink auditing
    // in request log. This way the user is better informed of what went
    // on.

    // http://www.whatwg.org/specs/web-apps/current-work/multipage/links.html#hyperlink-auditing
    //
    // Target URL = the href of the link
    // Doc URL = URL of the document containing the target URL
    // Ping URLs = servers which will be told that user clicked target URL
    //
    // `Content-Type` = `text/ping` (always present)
    // `Ping-To` = target URL (always present)
    // `Ping-From` = doc URL
    // `Referer` = doc URL
    // request URL = URL which will receive the information
    //
    // With hyperlink-auditing, removing header(s) is pointless, the whole
    // request must be cancelled.

    var requestURL = details.url;
    var requestType = requestTypeNormalizer[details.type] || 'other';
    if ( requestType === 'ping' ) {
        var linkAuditor = details.requestHeaders.getHeader('ping-to');
        if ( linkAuditor !== '' ) {
            var block = µm.userSettings.processHyperlinkAuditing;
            pageStore.recordRequest('other', requestURL + '{Ping-To:' + linkAuditor + '}', block);
            µm.logger.writeOne(tabId, 'net', '', requestURL, 'ping', block);
            if ( block ) {
                µm.hyperlinkAuditingFoiledCounter += 1;
                return { 'cancel': true };
            }
        }
    }

    // If we reach this point, request is not blocked, so what is left to do
    // is to sanitize headers.

    if ( µm.mustBlock(pageStore.pageHostname, details.hostname, 'cookie') ) {
        if ( details.requestHeaders.setHeader('cookie', '') ) {
            µm.cookieHeaderFoiledCounter++;
        }
    }

    if ( µm.tMatrix.evaluateSwitchZ('referrer-spoof', pageStore.pageHostname) ) {
        foilRefererHeaders(µm, details.hostname, details);
    }

    if ( µm.tMatrix.evaluateSwitchZ('ua-spoof', pageStore.pageHostname) ) {
        details.requestHeaders.setHeader('user-agent', µm.userAgentReplaceStr);
    }
};

/******************************************************************************/

var foilRefererHeaders = function(µm, toHostname, details) {
    var referer = details.requestHeaders.getHeader('referer');
    if ( referer === '' ) {
        return;
    }
    var µmuri = µm.URI;
    if ( µmuri.domainFromHostname(toHostname) === µmuri.domainFromURI(referer) ) {
        return;
    }
    //console.debug('foilRefererHeaders()> foiled referer for "%s"', details.url);
    //console.debug('\treferrer "%s"', header.value);
    // https://github.com/gorhill/httpswitchboard/issues/222#issuecomment-44828402
    details.requestHeaders.setHeader(
        'referer',
        µmuri.schemeFromURI(details.url) + '://' + toHostname + '/'
    );
    µm.refererHeaderFoiledCounter++;
};

/******************************************************************************/

// To prevent inline javascript from being executed.

// Prevent inline scripting using `Content-Security-Policy`:
// https://dvcs.w3.org/hg/content-security-policy/raw-file/tip/csp-specification.dev.html

// This fixes:
// https://github.com/gorhill/httpswitchboard/issues/35

var onHeadersReceived = function(details) {
    // console.debug('onHeadersReceived()> "%s": %o', details.url, details);

    // Ignore schemes other than 'http...'
    if ( details.url.lastIndexOf('http', 0) !== 0 ) {
        return;
    }

    var requestType = requestTypeNormalizer[details.type] || 'other';
    if ( requestType === 'frame' ) {
        return onSubDocHeadersReceived(details);
    }
    if ( requestType === 'doc' ) {
        return onMainDocHeadersReceived(details);
    }
};

/******************************************************************************/

var onMainDocHeadersReceived = function(details) {
    var µm = µMatrix;
    var tabId = details.tabId;
    var requestURL = details.url;

    // https://github.com/gorhill/uMatrix/issues/145
    // Check if the main_frame is a download
    if ( headerValue(details.responseHeaders, 'content-type').lastIndexOf('application/x-', 0) === 0 ) {
        µm.tabContextManager.unpush(tabId, requestURL);
    } else {
        µm.tabContextManager.push(tabId, requestURL);
    }

    var tabContext = µm.tabContextManager.lookup(tabId);
    if ( tabContext === null ) {
        return;
    }

    // console.debug('onMainDocHeadersReceived()> "%s": %o', requestURL, details);

    var rootHostname = tabContext.rootHostname;
    var blockScript = µm.mustBlock(rootHostname, rootHostname, 'script');

    // https://github.com/gorhill/httpswitchboard/issues/181
    var pageStore = µm.pageStoreFromTabId(tabId);
    if ( pageStore ) {
        pageStore.pageScriptBlocked = blockScript;
    }

    if ( !blockScript ) {
        return;
    }

    µm.logger.writeOne(tabId, 'net', rootHostname, requestURL + '{inline_script}', 'script', true);

    // If javascript not allowed, say so through a `Content-Security-Policy` directive.
    details.responseHeaders.push({
        'name': 'Content-Security-Policy',
        'value': "script-src 'none'"
    });
    return { responseHeaders: details.responseHeaders };
};

/******************************************************************************/

var onSubDocHeadersReceived = function(details) {
    var µm = µMatrix;
    var tabId = details.tabId;

    // console.debug('onSubDocHeadersReceived()> "%s": %o', details.url, details);

    // Do not ignore traffic outside tabs.
    // https://github.com/gorhill/httpswitchboard/issues/91#issuecomment-37180275
    var tabContext = µm.tabContextManager.lookup(tabId);
    if ( tabContext === null ) {
        return;
    }

    // Evaluate
    if ( µm.mustAllow(tabContext.rootHostname, details.hostname, 'script') ) {
        return;
    }

    // If javascript not allowed, say so through a `Content-Security-Policy`
    // directive.

    // For inline javascript within iframes, we need to sandbox.

    // https://github.com/gorhill/httpswitchboard/issues/73
    // Now because sandbox cancels all permissions, this means
    // not just javascript is disabled. To avoid negative side
    // effects, I allow some other permissions, but...

    // https://github.com/gorhill/uMatrix/issues/27
    // Need to add `allow-popups` to prevent completely breaking links on
    // some sites old style sites.

    // TODO: Reuse CSP `sandbox` directive if it's already in the
    // headers (strip out `allow-scripts` if present),
    // and find out if the `sandbox` in the header interfere with a
    // `sandbox` attribute which might be present on the iframe.

    // console.debug('onSubDocHeadersReceived()> FRAME CSP "%s": %o, scope="%s"', details.url, details, pageURL);

    µm.logger.writeOne(tabId, 'net', tabContext.rootHostname, details.url + '{inline_script}', 'script', true);

    // If javascript not allowed, say so through a `Content-Security-Policy` directive.
    details.responseHeaders.push({
        'name': 'Content-Security-Policy',
        'value': "script-src 'none'"
    });

    return { responseHeaders: details.responseHeaders };
};

/******************************************************************************/

var headerValue = function(headers, name) {
    var i = headers.length;
    while ( i-- ) {
        if ( headers[i].name.toLowerCase() === name ) {
            return headers[i].value.trim();
        }
    }
    return '';
};

/******************************************************************************/

// Caller must ensure headerName is normalized to lower case.

var headerIndexFromName = function(headerName, headers) {
    var i = headers.length;
    while ( i-- ) {
        if ( headers[i].name.toLowerCase() === headerName ) {
            return i;
        }
    }
    return -1;
};

/******************************************************************************/

var requestTypeNormalizer = {
    'font'          : 'css',
    'image'         : 'image',
    'main_frame'    : 'doc',
    'object'        : 'plugin',
    'other'         : 'other',
    'ping'          : 'ping',
    'script'        : 'script',
    'stylesheet'    : 'css',
    'sub_frame'     : 'frame',
    'xmlhttprequest': 'xhr'
};

/******************************************************************************/

vAPI.net.onBeforeRequest = {
    urls: [
        "http://*/*",
        "https://*/*"
    ],
    extra: [ 'blocking' ],
    callback: onBeforeRequestHandler
};

vAPI.net.onBeforeSendHeaders = {
    urls: [
        "http://*/*",
        "https://*/*"
    ],
    extra: [ 'blocking', 'requestHeaders' ],
    callback: onBeforeSendHeadersHandler
};

vAPI.net.onHeadersReceived = {
    urls: [
        "http://*/*",
        "https://*/*"
    ],
    types: [
        "main_frame",
        "sub_frame"
    ],
    extra: [ 'blocking', 'responseHeaders' ],
    callback: onHeadersReceived
};

/******************************************************************************/

var start = function() {
    vAPI.net.registerListeners();
};

/******************************************************************************/

return {
    start: start
};

/******************************************************************************/

})();

/******************************************************************************/

