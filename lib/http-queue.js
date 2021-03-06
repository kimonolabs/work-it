var q = require('q');
var encoder = require('./encoder');
var Backoff = require('./backoff');
var superagent = require('superagent');

var HttpQueue = function(redisQueue, httpConfig, opts) {
  this.httpConfig = httpConfig;
  
  this.name = opts.queue;
  this.retryName = (opts.retry || this.name);
  
  this.workingSet = opts.workingSet;
  this.redisQueue = redisQueue;
  
  this.poppers = [];
  
  this.backoff = new Backoff(this._cycle, this);
};

HttpQueue.prototype.push = function(message) {
  return q.reject(new Error('Cannot push to HTTP Queues'));
};

// HttpQueue.prototype.adopt = function(message, opts) {
//   return this.redisQueue.adopt(message, opts);
// };

HttpQueue.prototype.pop = function(id) {
  var d = q.defer();
  
  this.poppers.unshift({
    id: id,
    deferred: d
  });
  this.backoff.immediate();
  
  return d.promise;
};

HttpQueue.prototype.complete = function(task) {
  return this.redisQueue.complete(task);
};

HttpQueue.prototype.fail = function(task) {
  return this.redisQueue.fail(task);
};

HttpQueue.prototype.heartbeat = function(task) {
  return this.redisQueue.heartbeat(task);
};

HttpQueue.prototype._cycle = function() {
  if (this.poppers.length === 0) { return; }
  
  var self = this;
  var popper = this.poppers.pop();
  var request = superagent[this.httpConfig.method](this.httpConfig.url).set('Accept', 'application/json');
  
  if (this.httpConfig.headers) {
    Object.keys(this.httpConfig.headers).forEach(function(k) {
      request = request.set(k, self.httpConfig.headers[k]);
    });
  }
  
  if (this.httpConfig.query) {
    request = request.query(this.httpConfig.query);
  }
  
  if (popper.id) { request = request.set('X-Pop-ID', popper.id); }
  request = request.set('X-Retry-Queue', this.retryName);
  
  request.end(function(err, res) {
    if (err) {
      if ((!res || typeof(res.statusCode) !== 'number') && err.code !== 'ECONNREFUSED') {
        console.log(err.stack);
      }
      self.poppers.push(popper);
      return self.backoff.next();
    }
    
    if (res && typeof(res.statusCode) === 'number' && res.statusCode === 200) {
      var id = res.body;
      self.redisQueue.fetchTask(id).then(function(task) {
        popper.deferred.resolve(task);
      });
      self.backoff.reset();
    } else {
      self.poppers.push(popper);
      self.backoff.next();
    }
  });
};

module.exports = HttpQueue;
