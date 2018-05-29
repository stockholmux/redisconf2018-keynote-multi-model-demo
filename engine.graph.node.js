/*jslint
  node, multivar, white, single, this, long
*/
const
  argv              = require('yargs')                                  // "yargs" is a command line argument module
                      .demand('streamconnection')                       // 'streamconnection' is the path to the node_redis style connection object for the streaming connection
                      .demand('graphconnection')                        // 'graphconnection' is the path to the node_redis style connection object for the redis-graph connection
                      .argv,                                            // return it back as a plain object
  redis             = require('redis'),                                 // node_redis client library
  fs                = require('fs'),                                    // `fs` to read the external lua script
  connections       = {
    stream            : require(argv.streamconnection),                 // require in the actual files for the connection
    graph             : require(argv.graphconnection)
  },
  streamProcessor   = require('./streamProcessor.node.js'),             // our stream processing framework
  _                 = require('lodash'),                                // lodash to provide some helper functions
  graphKey          = 'x-graph';                                        // all graph operations will go off of this key


redis.add_command('graph.query');                                       // add in the GRAPH.QUERY command since it's a module and not automatically incuded in node_redis
redis.add_command('xread');                                             // add in the XREAD command since at time of writing Redis streams are not GA and thus not included in node_redis
redis.add_command('xadd');                                              // add in the XADD command since at time of writing Redis streams are not GA and thus not included in node_redis

let 
  graphRelateLua     = fs.readFileSync('./graph-relate-with-tweet.lua'),// encapsulate the graph relating commands in lua since we want to operate without round-trips
  client             = {
    graph             : redis.createClient(connections.graph),          // all graph operations go to this server (for operational simplicity)
    streamIn          : redis.createClient(connections.stream)          // all stream operations go to this server
  },
  nullCharStrip       = (s) => s.replace(/\u0000/g, ''),                // helper function to strip out null chars that end up in the reponse to graph at the moment
  paused              = true,                                           // start in a paused state, so everything doesn't start at once during the demo
  luaGraphRelate;                                                       // for the bound function that avoids calling lua directly


client.graph.script('LOAD', graphRelateLua, function(err, sha1) {       // LOAD the lua script into the script cache (warming)
  'use strict';
  if (err) { throw err; }                                               // we can't do anything if the script fails to load        

  console.log('Lua warmed to sha1',sha1);
  luaGraphRelate = _.bind(                                              // bind the graph client to a single command along with the correct key
    client.graph.evalsha,                                               // the function to bind to
    client.graph,                                                       // the `this` binding
    sha1,                                                               // first argument (the sha1 of the script)
    1,                                                                  // how many keys
    graphKey                                                            // our graph key
  );
});

client.streamOut = client.streamIn.duplicate();                         // Stream is blocking, so we need an in and an out

let 
  gQOut = _.bind(client.graph.graph_query,client.graph,graphKey),       // bind `.graph_query` (aka GRAPH.QUERY) to the client and supply the key as the first agrument 
  screenNameCondition = (screenName) => ` { screen_name : "${screenName.toLowerCase()}"}`, // define the template for the graph predicates
  elementProcessors = {                                                 // the element stream processors
    'control-plane-graph'   : (element) => function(done) {                  // for the stream 'control-plane-graph'
      let 
        dataObj = _(element[1]).chunk(2).fromPairs().value();           // The response for streams (XREAD) can be quite complicated, this is values passed into a stream

      if (dataObj.activate === 'true') {                                // if stream payload for `activate` is 'true' (avoid corercion)
        paused = false;                                                 // we're no longer paused
        console.log('Activate graph');
      } else if (dataObj.activate === 'false') {                        // if stream payload for `activate` is 'false'
        paused = true;                                                  // we're paused
        console.log('Deactivate graph');
      } else {
        console.log('dataObj', dataObj);                                // log if we get something unexpected
      }
      done();                                                           // indicate that we're ready for more messages
    },
    'graph-query'   : (element) => function(done) {                          // for the stream 'graph-query'        
      let 
        graphQuery = _(element[1]).chunk(2).fromPairs().value(),        // the data from the stream
        condition = {                                                   // we can have 0-2 conditions (0 = "All" in the UI)
          l1    : graphQuery.l1 ? screenNameCondition(                  // if we have a l1 condition, then use the template
            graphQuery.l1
          ) : '',                                                       // otherwise, it's an empty string
          l2    : graphQuery.l2 ? screenNameCondition(                  // if we have a l1 condition, then use the template
            graphQuery.l2
          ) : ''                                                        // otherwise, it's an empty string
        };
      
      gQOut(                                                            // run our GRAPH.QUERY, with the rather complicated query
        `MATCH (l2:User${condition.l1})-[:MENTIONED_IN]->(t:Tweet)<-[:MENTIONED_IN]-(l1:User${condition.l2}) RETURN DISTINCT l1.screen_name, l2.screen_name`,
        function(err,results) {
          if (err) { throw err; }                                       // in production you'd want to handle errors more gracefully

          results[0][0] = nullCharStrip(results[0][0]);                 // strip out the nulls that are currently added in certian circumstances 
          let 
            splitResults = results[0].map((s) => s.split(',')),         // results are outputted in a CSV practically
            forceGraph = {                                              // convert into D3's force directed graph JSON
              nodes : _(splitResults.slice(1))                          // get the 1st result
                .flattenDeep()                                          // flatten the deeply nested tree
                .uniq()                                                 // give me only unique reustsl
                .map((e) => ({ id : e, group : 1})).value(),            // format
              links : _(splitResults.slice(1))                          // convert into D3's force directed graph JSON
                .map((c) => _(c).map((e,i,all) => all[i+1] ? {          // map the links out, if there is resujlts
                    source : e,                                         // D3 always expresses as `target` / `source`
                    target : all[i+1]       
                  } : false )
                  .filter(_.identity).value()                           // filter out values that are non-unique
                )                            
                .flatten()                                              // flatten it
                .uniqBy((e) => [e.source,e.target].join(',')).value()   // unqiue values where target and source are duplicated
              };

          client.streamOut.xadd(                                        // add the results to another redis stream
            'graph-results',                                            // it's called... 'graph-results'
            '*',                                                        // the now timestamp/sequence
            'queryId',graphQuery.queryId,                               // `queryId` so things get to the right client
            'results',JSON.stringify(forceGraph),                       // `results` are the results from the graph query
            done                                                        // final callback
          );
        }
      );
    },
    'tweets' : (element) => function(done) {                                 // incoming tweets
      if (!paused) {                                                    // start processing if not paused
        let tweet = _(element[1])                                       // put them into a more usable form
                  .chunk(2)
                  .fromPairs()
                  .value();

        tweet.mentions = tweet.mentions
          .split(',')                                                   // mentions are in a comma delemited fomr
          .filter((e) => e.length > 0);                                 // filter out an 0 length mentions (which happens - deleted users?)
        let relationships = tweet.mentions.map((e) => e.toLowerCase()); // all mentions are lower case
        relationships.push(tweet.screen_name.toLowerCase());            // relate the writer of the tweet with the person mentioned
        relationships = _.uniq(relationships);                          // filter out any non-unique relatioships

        luaGraphRelate(tweet.id, ...relationships, done);               // pass in the tweet.id and all the relationships (it's variadic) and finally the callback
      } else {                                                          // paused...
        done();                                                         // noop
      }
    }

  };
streamProcessor(                                                        // stream processing framework
  client.streamIn,                                                      // our incoming stream
  Object.keys(elementProcessors),                                       // which ones to process (all, in this case)
  elementProcessors                                                     // how to process
);