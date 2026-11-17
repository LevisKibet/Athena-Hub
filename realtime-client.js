// Athena Sync: small WebSocket helper shared by the host screen and the phones.
// Reconnects on its own with a randomised back-off, so 450 phones that drop at
// the same moment don't all come back in the same instant.
(function(){
  function connect(opts) {
    var base = String(opts.url || '').replace(/\/+$/, '').replace(/^http/, 'ws');
    var url = base + '/room/' + encodeURIComponent(opts.pin) + '/ws?role=' + (opts.role === 'host' ? 'host' : 'player');
    var ws = null, closedByUs = false, attempt = 0, pingTimer = null, watchdog = null, lastSeen = 0, retryTimer = null;

    function status(s) { if (opts.onStatus) try { opts.onStatus(s); } catch (e) {} }

    function open() {
      clearTimeout(retryTimer);
      status(attempt ? 'reconnecting' : 'connecting');
      try { ws = new WebSocket(url); } catch (e) { return retry(); }
      ws.onopen = function() {
        attempt = 0; lastSeen = Date.now();
        status('open');
        startPing();
        if (opts.onOpen) opts.onOpen();
      };
      ws.onmessage = function(ev) {
        lastSeen = Date.now();
        if (ev.data === 'pong') return;
        var msg; try { msg = JSON.parse(ev.data); } catch (e) { return; }
        if (opts.onMessage) opts.onMessage(msg);
      };
      ws.onclose = function(ev) {
        stopPing();
        if (closedByUs) return;
        if (ev && ev.code === 4000) { status('closed'); if (opts.onClosedByServer) opts.onClosedByServer(ev.reason); return; }
        retry();
      };
      ws.onerror = function() { /* onclose follows */ };
    }

    function retry() {
      if (closedByUs) return;
      attempt++;
      status('reconnecting');
      var delay = Math.min(8000, 400 * Math.pow(1.7, attempt)) * (0.5 + Math.random());
      retryTimer = setTimeout(open, delay);
    }

    function startPing() {
      stopPing();
      pingTimer = setInterval(function(){ if (ws && ws.readyState === 1) ws.send('ping'); }, 20000);
      // If nothing (not even a pong) arrives for 50s, the connection is dead: reopen it.
      watchdog = setInterval(function(){
        if (ws && ws.readyState === 1 && Date.now() - lastSeen > 50000) { try { ws.close(); } catch (e) {} }
      }, 5000);
    }
    function stopPing() { clearInterval(pingTimer); clearInterval(watchdog); }

    // Phones that wake from sleep or switch networks: reconnect straight away.
    function wake() { if (!closedByUs && (!ws || ws.readyState > 1)) { attempt = 0; open(); } }
    window.addEventListener('online', wake);
    document.addEventListener('visibilitychange', function(){ if (!document.hidden) wake(); });

    open();

    return {
      send: function(obj) {
        if (!ws || ws.readyState !== 1) return false;
        ws.send(JSON.stringify(obj));
        return true;
      },
      isOpen: function() { return !!ws && ws.readyState === 1; },
      close: function() {
        closedByUs = true; stopPing(); clearTimeout(retryTimer);
        window.removeEventListener('online', wake);
        try { ws && ws.close(); } catch (e) {}
      }
    };
  }
  window.AthenaSync = { connect: connect };
})();
