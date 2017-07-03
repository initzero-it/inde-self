/*
 * Instant Developer Next
 * Copyright Pro Gamma Spa 2000-2016
 * All rights reserved
 */
/* global require, module */

var Node = Node || {};

// Import modules
Node.zlib = require("zlib");
//
// Import Classes
Node.AppClient = require("./appclient");
Node.Utils = require("../utils");


/**
 * @Class represent an Instan Developer session
 * @param {Node.Worker} par
 */
Node.AppSession = function (par)
{
  this.parent = par;
  //
  // New SessionID
  this.id = Node.Utils.generateUID36();
  //
  // List of client tokens (tele-collaboration)
  this.cTokens = [];
  //
  // Array of AppClients (clients connected with this session)
  this.appClients = [];
};


Node.AppSession.msgTypeMap = {
  appmsg: "appmsg",
  deleteChildAppSession: "dcas"
};


// Define usefull properties for this object
Object.defineProperties(Node.AppSession.prototype, {
  worker: {
    get: function () {
      return this.parent;
    }
  },
  app: {
    get: function () {
      return this.worker.app;
    }
  },
  config: {
    get: function () {
      return this.worker.config;
    }
  },
  logger: {
    get: function () {
      return this.worker.logger;
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
Node.AppSession.prototype.log = function (level, message, sender, data)
{
  // Add "local" info
  data = (data ? JSON.parse(JSON.stringify(data)) : {});
  data.sid = this.id;
  //
  this.app.log(level, message, sender, data);
};


/*
 * Send a message to the worker's child process
 * @param {object} msg - message to send
 */
Node.AppSession.prototype.sendToChild = function (msg)
{
  this.worker.sendToChild(msg);
  //
  // Sniff messages from client
  var testAuto = this.app.getTestById(this.testAutoId);
  if (testAuto && msg.content) {
    var child = testAuto.getChildBySID(this.id);
    testAuto = child || testAuto;
    testAuto.sniff(msg.content, true);
  }
};


/**
 * Opens a connection, save the socket on the array, redirect all the socket messages received from
 * the client to the child
 * @param {socket} socket
 * @param {Object} msg
 */
Node.AppSession.prototype.openSyncConnection = function (socket, msg)     // jshint ignore:line
{
  var pthis = this;
  //
  this.syncSocket = socket;
  socket.on("disconnect", function () {
    pthis.sendToChild({type: "sync", sid: {sidsrv: pthis.id}, cnt: {id: "disconnect"}});
  });
};


/**
 * Sends a message to an online app
 * @param {object} msg
 */
Node.AppSession.prototype.sendMessageToClientApp = function (msg)
{
  for (var i = 0; i < this.appClients.length; i++) {
    var acli = this.appClients[i];
    //
    var send;
    if (!msg.cidr)
      send = true;      // No CIDR -> send message to every app client
    else {
      // CIDR is there... check if I need to send the message to this client
      if (msg.cide)
        send = (acli.id === msg.cidr);    // If CIDE -> send the message only to the client that sent the message
      else
        send = (acli.id !== msg.cidr);    // If no CIDE -> send the message to all others but the one that sent the message
    }
    if (send)
      acli.sendAppMessage(msg);
  }
  //
  // Sniff messages to client
  var testAuto = this.app.getTestById(this.testAutoId);
  if (testAuto && msg.content) {
    var child = testAuto.getChildBySID(this.id);
    testAuto = child || testAuto;
    testAuto.sniff(msg.content, false);
  }
};


/**
 * Start the app in rest mode
 * @param {request} req
 * @param {response} res
 */
Node.AppSession.prototype.startRest = function (req, res)
{
  // Store the request/response objects so that the app can use them
  // (for instance, the app can answer to a REST request using the .restRes property and the app::sendResponse method)
  this.restReq = req;
  this.restRes = res;
  //
  // If I haven't done it yet create the physical process for the worker
  if (!this.worker.child)
    this.worker.createChild();
  //
  this.sendToChild({type: Node.AppSession.msgTypeMap.appmsg, sid: this.id,
    request: this.request, cookies: this.cookies});
  //
  // Schedule session death
  this.scheduleRESTDeath();
};


/**
 * Create a new app client (called by server's config)
 * @param {Node.Request} req
 * @param {Node.Response} res
 */
Node.AppSession.prototype.createAppClient = function (req, res)
{
  // Create a new app client
  var appClient = new Node.AppClient(this);
  //
  // If the CID of the new client has been already computed, use it here (see Config::processRun)
  if (this.newCid) {
    appClient.id = this.newCid;
    delete this.newCid;
  }
  //
  // Add it to the app clients array
  this.appClients.push(appClient);
  //
  // Log client creationg
  this.log("DEBUG", "Created a new app client", "AppSession.createAppClient", {cid: appClient.id});
  //
  // Initialize the new app client
  appClient.init(req, res);
  //
  return appClient;
};


/**
 * Delete an appClient
 * @param {appClient} appClient
 */
Node.AppSession.prototype.deleteAppClient = function (appClient)
{
  // Delete the app client from the array
  var idx = this.appClients.indexOf(appClient);
  this.appClients.splice(idx, 1);
  //
  // If this session has no master client or the master client has been deleted -> ask the worker to delete the session
  if (!this.masterAppClient || this.masterAppClient === appClient) {
    this.log("DEBUG", "Terminated MASTER client from session", "AppSession.deleteAppClient", {cid: appClient.id});
    //
    this.sendToChild({type: Node.AppSession.msgTypeMap.deleteChildAppSession, sid: this.id});
    //
    // Disconnect all other clients (if any)
    this.log("DEBUG", "Terminate all remaining app clients for this session", "AppSession.deleteAppClient");
    //
    for (var i = 0; i < this.appClients.length; i++)
      this.appClients[i].close();
    //
    // Ask the worker to terminate this session
    this.worker.deleteSession(this);
  }
  else
    this.log("DEBUG", "Terminated SLAVE client " + idx + " from session", "AppSession.deleteAppClient");
};


/**
 * Terminate this session
 */
Node.AppSession.prototype.terminate = function ()
{
  // Stop REST autokill timer
  if (this.killClient) {
    this.log("DEBUG", "Stop REST auto-kill timer", "AppSession.terminate");
    clearTimeout(this.killClient);
  }
  //
  // If this session have no clients, terminate it
  if (!this.appClients.length) {
    this.log("DEBUG", "Session has no clients -> terminate", "AppSession.terminate");
    this.worker.deleteSession(this);
    return;
  }
  //
  // This session has clients -> close them
  this.log("DEBUG", "Terminate all app clients", "AppSession.terminate");
  //
  for (var i = 0; i < this.appClients.length; i++)
    this.appClients[i].close();
};


/**
 * Program an automatic timer that will kill this REST session
 */
Node.AppSession.prototype.scheduleRESTDeath = function ()
{
  var pthis = this;
  //
  // If this session has a valid MASTER client it means that this is not a "pure" REST
  // but it a "true" session that received a "REST" command (like an image upload for instance)
  // In this case do nothing... session will die when the client disconnects (see appclient::init)
  if (this.masterAppClient)
    return;
  //
  // This is a "pure" REST session -> prepare a timer that will automatically kill this session
  // If this REST session has been used more than once... procrastinate timer
  if (this.killClient)
    clearTimeout(this.killClient);
  //
  // Compute new timeout
  var sessTimeout = this.sessionTimeout || 60000;
  this.killClient = setTimeout(function () {
    pthis.log("DEBUG", "REST session did not send a reply within " + (sessTimeout / 1000) + " sec -> deleted", "AppSession.scheduleRESTDeath");
    //
    // Timer expired
    delete pthis.killClient;
    //
    // Ask the worker to terminate this session
    pthis.sendToChild({type: Node.AppSession.msgTypeMap.deleteChildAppSession, sid: pthis.id});
  }, sessTimeout);
};


/**
 * A running app wants to change a session parameter
 * @param {object} params
 */
Node.AppSession.prototype.handleSessionParams = function (params)
{
  this.log("DEBUG", "Session params changed for session", "AppSession.handleSessionParams", params);
  //
  // Change session timeout
  if (params.sessionTimeout) {
    this.sessionTimeout = params.sessionTimeout;
    //
    // If this session is a "pure" REST session... I need to "re-schedule" my death
    this.scheduleRESTDeath();
  }
};


/**
 * Handles a CToken operation for this session
 * @param {object} msg
 */
Node.AppSession.prototype.handleCTokenOpMsg = function (msg)
{
  var ctidx = this.cTokens.indexOf(msg.cnt.ctoken);
  if (msg.cnt.op === "add" && ctidx === -1)
    this.cTokens.push(msg.cnt.ctoken);  // Add the ctoken to the array (if not there already)
  else if (msg.cnt.op === "del" && ctidx !== -1)
    this.cTokens.splice(ctidx, 1);  // Add the ctoken to the array (if not there already)
};


/**
 * Handles a send response message
 * @param {object} msg
 */
Node.AppSession.prototype.handleSendResponseMsg = function (msg)
{
  this.log("DEBUG", "Send REST response", "AppSession.handleSendResponseMsg", msg);
  //
  // Convert objects into strings
  if (typeof msg.text === "object")
    msg.text = JSON.stringify(msg.text);
  //
  msg.options = msg.options || {};
  //
  // Handle options, if any
  if (msg.options.contentType)
    this.restRes.writeHead(msg.code || 500, {"Content-Type": msg.options.contentType});
  else
    this.restRes.status(msg.code || 500);
  //
  // Send response
  this.restRes.end(msg.text + "");
};


/**
 * Search an app client by its ID
 * @param {string} id
 */
Node.AppSession.prototype.getAppClientById = function (id)
{
  for (var i = 0; i < this.appClients.length; i++) {
    var acli = this.appClients[i];
    if (acli.id === id)
      return acli;
  }
};


/**
 * Return the number of active sockets (i.e. number of connected clients)
 */
Node.AppSession.prototype.countClients = function ()
{
  return this.appClients.length;
};


// Export module
module.exports = Node.AppSession;