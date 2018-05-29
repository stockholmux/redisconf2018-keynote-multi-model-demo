/*jslint
  node, multivar, white, single, this, long
*/
const
  argv          = require('yargs')                                                        // "yargs" is a command line argument module
                  .demand('connection')                                                   // 'connection' is the path to the node_redis style connection object
                  .argv,                                                                  // return the values in an object
  redis         = require('redis'),                                                       // node_redis to manage the redis connection
  connection    = require(argv.connection),                                               // get the JSON of the connection info from the path
  streamProcessor
                = require('./streamProcessor.node.js'),                                   // our stream processing framework
  _             = require('lodash'),                                                      // lodash functionalish toolkit
  express       = require('express'),                                                     // the Express HTTP framework
  app           = express(),                                                              // init express
  EventEmitter  = require('eventemitter2').EventEmitter2,                                 // Allows for events with wildcards
  evEmitter     = new EventEmitter({                                                      // init event emitter
    wildcard    : true
  });

require('express-ws')(app);                                                               // Allows Express to handle websockets
  
redis.add_command('xread');                                                               // add in `xadd`,`xrange`, and `xread` because they're pre-prelease commands not in the library
redis.add_command('xadd');

let 
  streamClient = redis.createClient(connection),                                          // create the client for the incoming streams
  outClient    = streamClient.duplicate(),                                                // this client is for outgoing streams (control plane) 
  elementProcessors = {                                                                   // our element processors  
    'search-results'    : (el) => function(done) {                                        // Here we're bouncing the the stream for search results...
      evEmitter.emit(['search-results',el[1][1]].join('.'), el[1]);                       // ...into a local event
      done();                                                                             // loosely coupled
    },
    'word-cloud-stream' : (el) => function(done) {                                        // Here we're bouncing the the stream for word cloud words...
      evEmitter.emit('word-cloud-stream',el[1]);                                          // ...into a local event
      done();                                                                             // loosely coupled
    },

    'graph-results'   : (el) => function(done) {                                          // Here we're bouncing the the stream for graph relationships...
      evEmitter.emit(['graph-results',el[1][1]].join('.'), el[1]);                        // ...into a local event  
      done();                                                                             // loosely coupled
    }
  };
streamProcessor(                                                                          // stream processing framework
  streamClient,                                                                           // our incoming stream
  Object.keys(elementProcessors),                                                         // which ones to process (all, in this case)
  elementProcessors                                                                       // how to process these streams
);


function streamToWebSocket(server,eventName,route,processFn, additionalFn) {              // This is the proxy betwee streams and the websocket
  "use strict";
  server.ws(route,function(ws,req) {                                                      // routes are passed in and we generate the websocket "route"
    let proxyToWs = function(data) {                                                      // when we get the wildcard event, this is run
      if (ws.readyState === 1) {                                                          // make sure the websocket is not closed
        processFn.bind(this)(ws,req,data);                                                // then we run the processing function with the correct `this` context and pass in the relevant information as arguments
      }
    };
    evEmitter.on(eventName, proxyToWs);                                                   // do the actual event assignment
    if (additionalFn) {                                                                   // This is used for sending things back from the websocket
      additionalFn(ws,req);
    }
  
    ws.on('close',function() {                                                            // gracefully handle the closing of the websocket
      evEmitter.off(eventName,proxyToWs);                                                 // so we don't get closed socket responses
    });
  });

  return server;
}


let streamToThisApp = _.partial(streamToWebSocket,app);                                   // make our code nicer by partially apply the arguments
streamToThisApp('word-cloud-stream','/wc-top', function(ws,ignore,data) {                 // websocket route `/wc-top` will be processed on 'word-cloud-stream' events
  "use strict";
  ws.send(JSON.stringify(data.filter((ignore,i) => i % 2 )));                             // send the data - we actually don't need the ranking (just the order), so we can filter out ever other result!
});
streamToThisApp('stats','/stats',function(ws,ignore,data) {                               // `stats` is used to show the total number of items in search
  "use strict";
  ws.send(data[1]);                                                                       // bounce it right back to the websocket
});
streamToThisApp('graph-results.*','/graph/:queryId', function(ws,req,data) {              // the `*` is a wildcard for the queryId, which allows for matching with the URI (/graph/:queryId)
  "use strict";
  console.log('Graph connection',req.params.queryId);                                     // log for debugging
  let queryIdFromEvent = _(this.event).split('.').last();                                 // get our query ID
  if (queryIdFromEvent === req.params.queryId) {                                          // make sure that this message is for this query
    let dataObj = _(data)                                                                 // create a more usable object out of the redis results
        .chunk(2)                                                                         // linear into pairs
        .fromPairs()                                                                      // pair into object
        .mapValues(function(v,k) {                                                        // map values out so we can parse the correct value
          if (k === 'results') { v = JSON.parse(v); }                                     // parse the JSON out (no double encoding)
          return v;
        })
        .value();                                                                         // return the value from the lodash pipeline

    ws.send(JSON.stringify(dataObj));                                                     // send it over websockets
  }
}, function(ws,req) {                                                                     // handle messages that come in from the websocket
  "use strict";
  ws.on('message',function(someData) {                                                    // on the message
    let graphClauses;
    try {                                                                                 // try to parse it into JSON
      graphClauses = JSON.parse(someData); 
      console.log('clauses', graphClauses);
    } catch(e) {                                                                          // junk can come over this, we don't want it to crash the demo
      graphClauses = false;
      console.log('nope',e);
    }
    if (graphClauses) {                                                                   // we got a clause
      let graphArgs = _.concat(                                                           // create our arguments for the stream
        ['*'],                                                                            // with the most recent ID
        _(['l0','l1','l2'])                                                               // we only ended up using two clauses in the demo
          .map((clause) => graphClauses[clause] ? [clause, graphClauses[clause]] : false )// something or nothing
          .filter(_.identity)                                                             // we only want non-nothing values
          .flatten()                                                                      // in a lienar array
          .value(),                                                                       // get the plain value out
        ['queryId',req.params.queryId]                                                    // always include our query ID
      );

      outClient.xadd(                                                                     // add to a stream
        'graph-query',                                                                    // under our key
        graphArgs,                                                                        // with the generated arguments
        function(err) {                                                                   // callback
          if (err) { console.error(err); } else {                                         // Don't worry too much about error handling
            ws.send('QUERY SENT');                                                        // notify the client that we sent the query
          }
        }
      );
    }
  });
});

streamToThisApp('search-results.*','/search-results/:queryId', function(ws,req,data) {    // the `*` is a wildcard for the queryId, which allows for matching with the URI (/search-results/:queryId)
    "use strict";
    let queryIdFromEvent = _(this.event).split('.').last();                               // get our query ID
    if (queryIdFromEvent === req.params.queryId) {                                        // make sure that this message is for this query
      let dataObj = _(data)                                                               // create a more usable object out of the redis results
        .chunk(2)                                                                         // linear into pairs
        .fromPairs()                                                                      // pair into object
        .mapValues(function(v,k) {                                                        // map values out so we can parse the correct value
          if (k.match(/^docid\-/g)) {                                                     // parse the JSON out (no double encoding)
            v = JSON.parse(v);
          }
          return v;
        })
        .value();
      ws.send(JSON.stringify(dataObj));                                                   // send it back over the websocket to the client
    }
  },function(ws,req) {                                                                    // respond to messages over the websocket
    "use strict";
    ws.on('message',function(someData) {                                                  // when we get a websocket message
      outClient.xadd(                                                                     // add to a stream
        'search-query',                                                                   // to our stream of queries
        '*',                                                                              // at the most recent sequence
        'queryTerms',                                                                     // our field
        someData,                                                                         // our query
        'queryId',                                                                        // query ID field
        req.params.queryId,                                                               // query ID value
        function(err) {
          if (err) { console.error(err); } else {                                         // log the error if we have one
            ws.send('QUERY SENT');                                                        // notify the client that we've sent the query
          }
        }
      );
    });
  });

app.ws('/control-plane',function(ws) {                                                    // control plane web socket events
  "use strict";
  ws.on('message',function(someData) {                                                    // when we get a message
    try {
      let someJson = JSON.parse(someData);                                                // parse it
      if (someJson.fn && someJson.status) {                                               // if it has a function and a status
        let controlStreamKey = ['control','plane',someJson.fn].join('-');                 // build the control plane stream
        outClient.xadd(                                                                   // add it to a stream
          controlStreamKey,                                                               // at our key
          '*',                                                                            // with the most current sequence
          'activate',                                                                     // field
          someJson.status === 'on',                                                       // value = will be String(true) or String(false) (loose typing FTW!)
          function(err) {                                                                 // callback
            if (err) { console.error(err); } else {                                       // log errors if we get them
              console.log('sent activation status',controlStreamKey,someJson.status === 'on'); // log the success for debugging
            }
          }
        );
      }
    } catch(e) {                                                                          // we got a message that wasn't JSON
      console.log('control plane error',e);                                               // log it
    }
  });
});

app                                                                                       // our server app
  .use('/bower_components',express.static('bower_components'))                            // static components (vaadin, polymer)
  .use(express.static('static'))                                                          // static pages (HTML)
  .listen(4000);                                                                          // over port 4000
