/*jslint
  node, multivar, white, single, this, long
*/
const
  argv          = require('yargs')                                  // "yargs" is a command line argument module
                  .demand('connection')                             // 'connection' is the path to the node_redis style connection object
                  .argv,                                            // return the values in an object
  redis         = require('redis'),                                 // node_redis to manage the redis connection
  connection    = require(argv.connection),
  streamProcessor
                = require('./streamProcessor.node.js'),
  _             = require('lodash'),
  express       = require('express'),
  app           = express(),
  EventEmitter  = require('eventemitter2').EventEmitter2,
  evEmitter     = new EventEmitter({
    wildcard    : true
  });

require('express-ws')(app);
  
redis.add_command('xread');
redis.add_command('xadd');

let 
  streamClient = redis.createClient(connection),
  outClient    = streamClient.duplicate(),
  elementProcessors = {
    'search-results'    : (el) => function(done) {
      evEmitter.emit(['search-results',el[1][1]].join('.'), el[1]);
      done();
    },
    'word-cloud-stream' : (el) => function(done) {
      evEmitter.emit('word-cloud-stream',el[1]);
      done();
    },
    /*'stats'             : (el)  => function(done) {
      evEmitter.emit('stats',el[1]);
      done();
    },*/
    'graph-results'   : (el) => function(done) {
      evEmitter.emit(['graph-results',el[1][1]].join('.'), el[1]);
      done();
    }
    //need to have a discovery stream
  };
streamProcessor(
  streamClient,
  Object.keys(elementProcessors),
  elementProcessors
);


function streamToWebSocket(server,eventName,route,processFn, additionalFn) {
  "use strict";
  server.ws(route,function(ws,req) {
    let proxyToWs = function(data) {
      if (ws.readyState === 1) {
        processFn.bind(this)(ws,req,data);
      }
    };
    evEmitter.on(eventName, proxyToWs);
    if (additionalFn) { 
      additionalFn(ws,req);
    }
  
    ws.on('close',function() {
      evEmitter.off(eventName,proxyToWs);
    });
  });

  return server;
}


let streamToThisApp = _.partial(streamToWebSocket,app);
streamToThisApp('word-cloud-stream','/wc-top', function(ws,ignore,data) {
  "use strict";
  ws.send(JSON.stringify(data.filter((ignore,i) => i % 2 )));
});
streamToThisApp('stats','/stats',function(ws,ignore,data) {
  "use strict";
  ws.send(data[1]);
});
streamToThisApp('graph-results.*','/graph/:queryId', function(ws,req,data) {
  "use strict";
  console.log('Graph connection',req.params.queryId);
  let queryIdFromEvent = _(this.event).split('.').last();
  if (queryIdFromEvent === req.params.queryId) {
    let dataObj = _(data)
        .chunk(2)
        .fromPairs()
        .mapValues(function(v,k) {
          if (k === 'results') { v = JSON.parse(v); }
          return v;
        })
        .value();

    ws.send(JSON.stringify(dataObj));
  }
}, function(ws,req) {
  "use strict";
  console.log('graph message handler');
  ws.on('message',function(someData) {
    let graphClauses;
    try {
      graphClauses = JSON.parse(someData);
      console.log('clauses', graphClauses);
    } catch(e) {
      graphClauses = false;
      console.log('nope',e);
    }
    if (graphClauses) {
      let graphArgs = _.concat(
        ['*'],
        _(['l0','l1','l2'])
          .map((clause) => graphClauses[clause] ? [clause, graphClauses[clause]] : false )
          .filter(_.identity)
          .flatten()
          .value(),
        ['queryId',req.params.queryId]
      );

      outClient.xadd(
        'graph-query',
        graphArgs,
        function(err) {
          if (err) { console.error(err); } else {
            ws.send('QUERY SENT');
          }
        }
      );
    }
  });
});

streamToThisApp('search-results.*','/search-results/:queryId', function(ws,req,data) {
    "use strict";
    let queryIdFromEvent = _(this.event).split('.').last();
    if (queryIdFromEvent === req.params.queryId) {
      let dataObj = _(data)
        .chunk(2)
        .fromPairs()
        .mapValues(function(v,k) {
          if (k.match(/^docid\-/g)) {
            v = JSON.parse(v);
          }
          return v;
        })
        .value();
      ws.send(JSON.stringify(dataObj));
    }
  },function(ws,req) {
    "use strict";
    ws.on('message',function(someData) {
      outClient.xadd(
        'search-query',
        '*',
        'queryTerms',
        someData,
        'queryId',
        req.params.queryId,
        function(err) {
          if (err) { console.error(err); } else {
            ws.send('QUERY SENT');
          }
        }
      );
    });
  });

app.ws('/control-plane',function(ws) {
  "use strict";
  ws.on('message',function(someData) {
    try {
      let someJson = JSON.parse(someData);
      if (someJson.fn && someJson.status) {
        let controlStreamKey = ['control','plane',someJson.fn].join('-');
        outClient.xadd(
          controlStreamKey,
          '*',
          'activate',
          someJson.status === 'on',
          function(err) {
            if (err) { console.error(err); } else {
              console.log('sent activation status',controlStreamKey,someJson.status === 'on');
            }
          }
        );
      }
    } catch(e) {
      console.log('control plane error',e);
    }
  });
});

//on init disable everything.

app
  .use('/bower_components',express.static('bower_components'))
  .use(express.static('static'))
  .listen(4000);
