/*
 * Instant Developer Next
 * Copyright Pro Gamma Spa 2000-2016
 * All rights reserved
 */
/* global require, module, process */

var Node = Node || {};

// Import modules
Node.child = require("child_process");

// Import Classes
Node.AppSession = require("./appsession");

/*
 * @Class representing an app worker
 * @param {Node.App} par
 */
Node.Worker = function (par)
{
  this.parent = par;
  //
  // Sessions in this worker
  this.sessions = [];
};


Node.Worker.msgTypeMap = {
  initApp: "initApp",
  processRequest: "pr",
  sessionParams: "sespar",
  terminate: "terminate",
  deleteSession: "delses",
  sendRestResponse: "rest",
  watchdogRequest: "wdreq",
  watchdogResponse: "wdres",
  connectionDB: "conDB",
  sync: "sync",
  syncBroad: "syncBroad",
  cloudConnectorMsg: "ccm",
  install: "inst",
  installResult: "instres",
  createDB: "cdb",
  createDBresult: "cdbres",
  serverSession: "serverSession",
  testStartResult: "testres",
  cTokenOp: "ctop"
};


// Define usefull properties for this object
Object.defineProperties(Node.Worker.prototype, {
  app: {
    get: function () {
      return this.parent;
    }
  },
  user: {
    get: function () {
      return this.app.user;
    }
  },
  server: {
    get: function () {
      return this.app.server;
    }
  },
  config: {
    get: function () {
      return this.app.config;
    }
  },
  logger: {
    get: function () {
      return this.app.logger;
    }
  }
});


/**
 * Log a new message
 * @param {string} level - message level (DEBUG, INFO, WARN, ERROR)
 * @param {string} message - text message
 * @param {string} sender - function that generated the message
 * @param {object} data - optional data to log
 */
Node.Worker.prototype.log = function (level, message, sender, data)
{
  // Add "local" info
  data = (data ? JSON.parse(JSON.stringify(data)) : {});
  data.app = this.app.name;
  data.user = this.user.userName;
  data.workerIdx = this.app.workers.indexOf(this);
  data.totalWorkers = this.app.workers.length;
  //
  this.logger.log(level, message, sender, data);
};


/**
 * Create a new child process for this worker
 */
Node.Worker.prototype.createChild = function ()
{
  var pthis = this;
  var apppath = this.config.appDirectory + "/apps/" + this.app.name + "/server/app.js";
  //
  // Create the child process
  // If I'm installing, get ERRORS from child stderr stream
  var runErrors = [];
  if (this.installCallback) {
    this.child = Node.child.fork(apppath, [], {silent: true});     // Capture StdErr errors
    //
    this.child.stderr.on("data", function (err) {
      err += "";      // Convert error into string
      pthis.log("WARN", "Application error: " + err, "Worker.createChild");
      //
      // Store error in errors array
      runErrors.push(err);
    });
  }
  else
    this.child = Node.child.fork(apppath);
  //
  // Log child creation
  this.log("DEBUG", "Created app child", "Worker.createChild");
  //
  // Initialize app child
  this.child.send({type: Node.Worker.msgTypeMap.initApp, sender: "master",
    name: this.app.name, url: this.config.getUrl(), path: this.config.appDirectory + "/apps/" + this.app.name,
    publicUrl: this.config.getUrl() + "/" + this.app.name, online: true});
  //
  // Tell the app how to connect with the database
  var constring = "postgres://" + this.config.dbUser + ":" + this.config.dbPassword + "@" + this.config.dbAddress + ":" + this.config.dbPort;
  this.child.send({type: Node.Worker.msgTypeMap.connectionDB,
    username: (this.user.userName === "manager" ? undefined : this.user.userName), constring: constring});
  //
  // Listen for messages
  this.child.on("message", function (msg) {
    pthis.handleAppChildMessage(msg);
  });
  this.child.on("disconnect", function () {
    pthis.log("DEBUG", "Worker child disconnected", "Worker.createChild");
    //
    // Now the child is dead
    delete pthis.child;
    //
    // Child has died. If I was installing the child crashed during install
    if (pthis.installCallback) {
      var err = (runErrors.length > 0 ? runErrors.join("\n") : "Unknown error");
      pthis.installCallback({err: "Installation failed: " + err});
      delete pthis.installCallback;
    }
    else if (pthis.app.workers.indexOf(pthis) !== -1) {
      // If I'm still inside my app's worker list it means I've crashed...
      // (see app::deleteWorker: first the worker is removed then the worker's child is disconnected)
      pthis.log("WARN", "Worker is still inside app's list (maybe it crashed?) -> Delete worker all its sessions", "Worker.createChild",
              {numsession: pthis.sessions.length});
      //
      // Terminate and delete all worker's sessions
      while (pthis.sessions.length) {
        var sToDel = pthis.sessions[0];
        sToDel.terminate();
        pthis.deleteSession(sToDel);
      }
      //
      // Now, deleting all sessions should have programmed my death (see Worker::deleteSession).
      // I don't need to die... I just need a new child...
      if (pthis.killWorkerTimer) {
        clearTimeout(pthis.killWorkerTimer);
        delete pthis.killWorkerTimer;
      }
      //
      pthis.log("INFO", "Crashed worker restored", "Worker.createChild");
    }
  });
  //
  // Start the child process watchdog
  this.startWatchDog();
};


/**
 * Kill the child process
 * @param {boolean} force - if true sends a SIGKILL message
 */
Node.Worker.prototype.killChild = function (force)
{
  // If dead, do nothing
  if (!this.child)
    return;
  //
  // If there was a kill timer, stop it
  if (this.killWorkerTimer) {
    clearTimeout(this.killWorkerTimer);
    delete this.killWorkerTimer;
  }
  //
  // Stop watchDog... I'll be dead soon!
  this.stopWatchDog();
  //
  // If requested use brute force
  if (force) {
    this.log("WARN", "Forcedly kill worker child", "Worker.killChild");
    this.child.kill("SIGKILL");
    //
    // Now the child should be dead
    delete this.child;
  }
  else {
    this.log("DEBUG", "Disconnects worker child", "Worker.killChild");
    this.child.disconnect();
  }
};


/**
 * Handle app child messages (i.e. messages sent by app.js)
 * @param {object} msg
 */
Node.Worker.prototype.handleAppChildMessage = function (msg)
{
  var appsess;
  //
  switch (msg.type) {
    case Node.Worker.msgTypeMap.processRequest:
      // Send the message to the right app session
      appsess = this.server.appSessions[msg.sid];
      if (appsess)
        appsess.sendMessageToClientApp(msg);
      else
        this.log("WARN", "Can't process request: session not found", "Worker.handleAppChildMessage", msg);
      break;

    case Node.Worker.msgTypeMap.sessionParams:
      // Send the message to the right app session
      appsess = this.server.appSessions[msg.sid];
      if (appsess)
        appsess.handleSessionParams(msg.cnt);
      else
        this.log("WARN", "Can't handle session params message: session not found", "Worker.handleAppChildMessage", msg);
      break;

    case Node.Worker.msgTypeMap.deleteSession:
      appsess = this.server.appSessions[msg.sid];
      if (appsess)
        appsess.terminate();
      break;

    case Node.Worker.msgTypeMap.sendRestResponse:
      appsess = this.server.appSessions[msg.sid];
      if (appsess)
        appsess.handleSendResponseMsg(msg);
      else
        this.log("WARN", "Can't send REST response: session not found", "Worker.handleAppChildMessage", msg);
      break;

    case Node.Worker.msgTypeMap.watchdogResponse:
      if (this.watchdog)
        this.watchdog.lastTick = new Date();
      break;

    case Node.Worker.msgTypeMap.sync:
      this.handleSync(msg);
      break;

    case Node.Worker.msgTypeMap.syncBroad:
      this.handleSyncBroad(msg);
      break;

    case Node.Worker.msgTypeMap.cloudConnectorMsg:
      this.user.handleCloudConnectorMessage(msg.cnt, this);
      break;

    case Node.Worker.msgTypeMap.createDB:
      this.handleCreateDBMsg(msg);
      break;

    case Node.Worker.msgTypeMap.cTokenOp:
      appsess = this.server.appSessions[msg.sid];
      if (appsess)
        appsess.handleCTokenOpMsg(msg);
      break;

    case Node.Worker.msgTypeMap.installResult:
      if (this.installCallback) {
        this.installCallback(msg.cnt);      // Call callback attached at the beginning of the install method (see Worker::installApp)
        delete this.installCallback;
      }
      else
        this.log("WARN", "Can't handle install result message: no callback", "Worker.handleAppChildMessage", msg);
      break;

    case Node.Worker.msgTypeMap.testStartResult:
      if (this.app.testAuto && msg.cnt && this.app.testAuto[msg.cnt.testAutoId])
        this.app.testAuto[msg.cnt.testAutoId].handleUpdateSchemaResult(msg.cnt);
      break;

    case Node.Worker.msgTypeMap.serverSession:
      this.handleServerSessionMsg(msg);
      break;

    default:
      this.log("WARN", "Unhandled message", "Worker.handleAppChildMessage", msg);
      break;
  }
};


/*
 * Process the sync message
 * @param {object} msg
 */
Node.Worker.prototype.handleSync = function (msg)
{
  var session = this.server.appSessions[msg.sid.sidsrv];
  if (!session)
    return this.log("WARN", "Can't handle SYNC message: session not found", "Worker.handleSync", msg);
  //
  if (msg.cnt.id === "disconnect")
    session.syncSocket.disconnect();
  else
    session.syncSocket.emit("sync", msg);
};


/*
 * Process the syncBroad message
 * @param {object} msg
 */
Node.Worker.prototype.handleSyncBroad = function (msg)
{
  for (var i = 0; i < this.app.workers.length; i++) {
    var wrk = this.app.workers[i];
    //
    // Skip "dead" workers (i.e. workers with no child process)
    if (!wrk.child)
      continue;
    //
    wrk.child.send({type: Node.Worker.msgTypeMap.syncBroad, cnt: msg.cnt});
  }
};


/*
 * Handles a create DB message
 * @param {object} msg
 */
Node.Worker.prototype.handleCreateDBMsg = function (msg)
{
  var pthis = this;
  //
  // Create the database for worker's user
  this.user.createDatabase(msg.dbname, function (result) {
    // Extract error message (if embedded)
    if (result && result.err)
      result = result.err;
    //
    // It's an error only if the error is not "the DB already exists"
    var err = (result !== "Database already exists" ? result : undefined);
    if (err)
      pthis.log("WARN", "Can't create database: " + err, "Worker.handleCreateDBMsg", {dbname: msg.dbname});
    //
    // Report to callee
    if (pthis.child)    // The child could be dead if it crashed some time ago...
      pthis.child.send({type: Node.Worker.msgTypeMap.createDBresult, dbname: msg.dbname, err: err});
    else
      pthis.log("WARN", "Child process is dead -> can't send create DB result", "Worker.handleCreateDBMsg", {dbname: msg.dbname, err: err});
  });
};


/*
 * Handles a server session message
 * @param {object} msg
 */
Node.Worker.prototype.handleServerSessionMsg = function (msg)
{
  var name = msg.cnt.name;
  var ss = this.app.getServerSession(name);
  //
  switch (msg.cnt.cmd) {
    case "start":
      if (ss)
        return this.log("WARN", "Can't start server session: session with same name already exists", "Worker.handleServerSessionMsg", msg);
      //
      this.app.startServerSession(name);
      break;

    case "stop":
      if (!ss)
        return this.log("WARN", "Can't stop server session: session not found", "Worker.handleServerSessionMsg", msg);
      //
      ss.terminate();
      break;

    case "running":
      var ev = {id: "serverSessionCB", content: {cbId: msg.cnt.cbId, running: !!ss}, master: true};
      this.sendToChild({type: Node.AppSession.msgTypeMap.appmsg, sid: msg.cnt.sid, content: [ev], request: msg.cnt.request});
      break;
  }
};


/*
 * Get a server session by name
 * @param {string} name
 * @returns {Node.AppSession}
 */
Node.Worker.prototype.getServerSession = function (name)
{
  var ids = Object.keys(this.sessions);
  for (var i = 0; i < ids.length; i++) {
    var s = this.sessions[ids[i]];
    if (s.name === name)
      return s;
  }
};


/**
 * Starts the watchdog that checks if the child process is up and running properly
 */
Node.Worker.prototype.startWatchDog = function ()
{
  // If there was a previous watchdog, kill it
  this.stopWatchDog();
  //
  // Check process every 5 seconds... If it does not reply for more than 30 seconds, kill it
  this.watchdog = {};
  this.watchdog.lastTick = new Date();
  this.watchdog.intervalID = setInterval(function () {
    // If I'm already dying, do nothing
    if (this.killWorkerTimer)
      return;
    //
    // If the elapsed time exceeded
    var dt = (new Date() - this.watchdog.lastTick);
    if (dt > 30000) {
      this.log("WARN", "Child did not answer for 30sec -> killing it", "Worker.startWatchDog");
      //
      // Kill the child (brute force)
      this.killChild(true);
      //
      // Stop the watchdog
      this.stopWatchDog();
      return;
    }
    //
    // If the child is still here, check if is alive and kicking
    if (this.child)
      this.sendToChild({type: Node.Worker.msgTypeMap.watchdogRequest});
  }.bind(this), 5000);
};


/**
 * Stops the watchdog that checks if the child process is up and running properly
 */
Node.Worker.prototype.stopWatchDog = function ()
{
  // If the watchdog was enabled stop its interval
  if (this.watchdog && this.watchdog.intervalID)
    clearInterval(this.watchdog.intervalID);
  //
  delete this.watchdog;
};


/**
 * Get the number of sessions for this worker
 */
Node.Worker.prototype.getLoad = function ()
{
  return this.sessions.length;
};


/**
 * Create a new session
 * @returns {Node.AppSession}
 */
Node.Worker.prototype.createNewSession = function ()
{
  // If this worker was dying (see Worker::deleteSession), stop the death timer
  if (this.killWorkerTimer) {
    clearTimeout(this.killWorkerTimer);
    delete this.killWorkerTimer;
  }
  //
  // Create a new session
  var session = new Node.AppSession(this);
  this.sessions.push(session);
  //
  // Add this session to the "global" session map in the server
  // (so that he can route all connections to this session)
  this.server.appSessions[session.id] = session;
  //
  // Log the operation
  this.log("DEBUG", "Created app session", "Worker.createNewSession", {sid: session.id});
  //
  return session;
};


/**
 * Delete the session
 * @param {session} session
 */
Node.Worker.prototype.deleteSession = function (session)
{
  var pthis = this;
  this.log("DEBUG", "Delete worker session", "Worker.deleteSession", {sid: session.id});
  //
  // Remove the session from my session list
  var idx = this.sessions.indexOf(session);
  if (idx === -1)
    return this.log("WARN", "Session not found", "Worker.deleteSession", {sid: session.id});
  //
  this.sessions.splice(idx, 1);
  //
  // Delete the session from the server global map
  delete this.server.appSessions[session.id];
  //
  // If there are no more sessions in this worker, delete it after 10 seconds
  if (this.getLoad() === 0) {
    pthis.log("DEBUG", "Worker is empty", "Worker.deleteSession");
    //
    this.killWorkerTimer = setTimeout(function () {
      pthis.log("DEBUG", "Worker is empty and timeout expired -> delete it", "Worker.deleteSession");
      pthis.app.deleteWorker(pthis);
    }, 5000);  // wait 5 sec
  }
};


/**
 * Terminate the worker
 * @param {object} options ({force, timeout, msg})
 */
Node.Worker.prototype.terminate = function (options)
{
  if (this.child)
    this.child.send({type: Node.Worker.msgTypeMap.terminate, options: options});
  else
    this.log("WARN", "Worker has no child: can't send TERMINATE", "Worker.terminate");
};


/**
 * Send a message to worker's child
 * @param {object} msg - message to send
 */
Node.Worker.prototype.sendToChild = function (msg)
{
  if (this.child)
    this.child.send(msg);
  else
    this.log("WARN", "Can't send message: worker's child is gone", "Worker.sendToChild", msg);
};


/**
 * Returns the worker's status
 * @param {function} callback - function(result, err)
 */
Node.Worker.prototype.getStatus = function (callback)
{
  var stat = {sessions: this.sessions.length};
  //
  // If I've no child, I've nothing more to say
  if (!this.child)
    return callback(stat);
  //
  // Add child's PID
  stat.pid = this.child.pid;
  //
  // On Windows there is nothing I can add
  if (/^win/.test(process.platform))   // windows
    return callback(stat);
  //
  // Add more info (per-process CPU load)
  Node.child.execFile("/bin/ps", ["-o", "pcpu", "-p", this.child.pid], function (err, stdout, stderr) {   // jshint ignore:line
    if (err) {
      this.log("ERROR", "Error getting the CPU load: " + (stderr || err), "Worker.getStatus");
      return callback(null, "Error getting the CPU load: " + (stderr || err));
    }
    //
    stdout = stdout.split("\n")[1];   // Remove headers
    stat.cpuLoad = parseFloat(stdout);
    //
    callback(stat);
  }.bind(this));
};


// Export module
module.exports = Node.Worker;