/*jslint
  node, multivar, white, single, long
*/
const
  argv          = require('yargs')                                                        // 'yargs' is a command line argument module
                  .demand('searchconnection')                                             // 'searchconnection' is the path to the node_redis style connection object for the search redis database
                  .demand('streamconnection')                                             // 'streamconnection' is the path to the node_redis style connection object for the stream redis database
                  .argv,                                                                  // return as a plain object
  _             = require('lodash'),
  rediSearchBindings  
                = require('redis-redisearch'),                                            // supplies node_redis with the extended RediSearch commands
  rediSearch          
                = require('../redisearchclient'),                                         // this a richer redisearch client for node.js
  fields        = require('./fields.node.js'),                                            // our fields in the schema
  streamConnection
                = require(argv.streamconnection),                                         // since streaming is blocking, we'll need two clients to be bi-directional
  searchConnection
                = require(argv.searchconnection),                                         // this client will handle querying the search idnex
  streamProcessor
                = require('./streamProcessor.node.js'),                                   // our stream processing framework
  redis         = require('redis'),                                                       // node_redis
  searchIndex   = 'tweet-search';                                                         // the index we'll be using for RediSearch

redis.add_command('xread');                                                               // add in the xread and xadd commands to the node_redis library (since it's prerelease)
redis.add_command('xadd');
rediSearchBindings(redis);                                                                // give the RediSearch commands to node_redis

let
  streamClient  = redis.createClient(streamConnection),                                   // the stream client (for incoming items to indexing)
  resultsClient = streamClient.duplicate(),                                               // and the results client (for results) 
  searchClient  = redis.createClient(searchConnection),                                   // the client for all redisearch operations
  tweetSearch   = rediSearch(searchClient,searchIndex),                                   // init search library
  dupeCount     = 0,                                                                      // just a metric
  paused        = true;                                                                   // start out in paused mode

let elementProcessors = {                                                                 // our element processors
  'search-query'  : function(element) {                                                   // we get an element
    "use strict";
    return function(done) {                                                               // and we'll close over it.
      let searchQuery = _(element[1])                                                     // use a lodash pipeline to make meaning out of the stream structure
                        .chunk(2)                                                         // linear array into nested pairs
                        .fromPairs()                                                      // then into an object
                        .value();                                                         // get the value out
      tweetSearch.search(                                                                 // execute a query
        searchQuery.queryTerms+'*',                                                       // the '*' allows for wildcard matching in the query - makes search as you type more responsive
        function(err,searchResults) {                                                     // our results callback
          if (String(err).indexOf('ReplyError: Syntax error at offset') > -1) {           // do we have an query syntax error?
            done();                                                                       // just move on
          } else if (err) {                                                               // do we have any other error?
            console.log(String(err));                                                     // log it 
            done(err);                                                                    // pass it back
          } else {                                                                        // no error? Awesome.
            let args = [ '*','queryId',searchQuery.queryId];                              // geneate the arguments for XADD - at the current time, with the query id

            if (searchResults.results.length > 0) {                                       // We have some results to stream back?
              args = args.concat(searchResults.results.map(function(aDocObj) {            // concatenate it to the arguments above - it'll be quite a bit
                return [
                  'docid-'+aDocObj.docId,                                                 // the field is the document id prefixed with 'docid-'
                  JSON.stringify(aDocObj.doc)                                             // just some javascript as the value
                ];
              }));
            }
            args.push('totalResults',searchResults.totalResults);                         // after all the results are in, push in the total number of results
            args = _.flatten(args);                                                       // Redis likes flat arguments
            resultsClient.xadd('search-results',args,done);                               // then send it back to the search results stream
          }
        }
      );
    };
  },
  'tweets' : function(element) {                                                          // we get an element
    "use strict";
    return function(done) {                                                               // and we're closing over it.
      if (!paused) {                                                                      // if we're active (not paused)
        let tweet = _(element[1])                                                         // use a lodash pipeline to make meaning out of the stream structure
                .chunk(2)                                                                 // linear array into nested pairs
                .fromPairs()                                                              // then into an object
                .value();                                                                 // get the value out

        let tweetId = tweet.id;                                                           // take the tweetId out (later we'll delete it from the object)                         
        tweet.tweet_text = tweet.text;                                                    // we need the object in a specific form so we'll reassign this...
        delete tweet.id;                                                                  // and remove the id
        delete tweet.text;                                                                // and the text
            
        tweetSearch.add(tweetId, tweet, function(err) {                                   // tweetId is the documentId, the tweet is the payload, then a callback once indexed
        if (err && String(err).indexOf('Document already in index') > -1) {               // check for dupe by looking at the error
            dupeCount += 1;                                                               // incr the duplicate counts
            console.log('Duplicate. Dupe Count:',dupeCount);                              // this is more just for debugging, but could be interesting
            done(null);                                                                   // since we're loosely coupled, we don't need to do anything with this error, just go on with life
          } else {
            done(err);                                                                    // if we get any other error, we sent it back up the chain for error reporting.
          }
        });
      } else {                                                                            // we're not active...
        done();                                                                           // ...so noop
      }
    };
  },
  'control-plane-search'   : (element) => function(done) {                                // get an element and close over it
    let dataObj = _(element[1]).chunk(2).fromPairs().value();                             // you know the drill, grab the linear array, chunk it into pairs, turn it into an object
    if (dataObj.activate === 'true') {                                                    // if we get the string "true", we turn on
      paused = false;                                                                     // turn off the global
      console.log('Activate search');                                                     // log our activity
    } else if (dataObj.activate === 'false') {                                            // if we get the string "false", we turn off
      paused = true;                                                                      // We're now paused
      console.log('Deactivate search');                                                   // log our activity
    }
    done();                                                                               // we've done what we need to do
  }
};
let processStream = _.partial(                                                            // make our stream processor easy to write
  streamProcessor,                                                                        // the function we'll apply our arguments to
  streamClient,                                                                           // first argument is the client
  Object.keys(elementProcessors),                                                         // then the items we want to listen for (all of them, in this case)
  elementProcessors                                                                       // finally our stream processing functions
);

searchClient.ft_info(searchIndex,function(err) {                                          // At script start, we need to check to see if the index exists with FT.INFO
  "use strict";
  if (err && (String(err).indexOf('Unknown Index name') > -1)) {                          // examine the error string to see if see an unknown index
    console.log('index did not exist, creating');                                         // log that we're creating the index
    tweetSearch.createIndex(                                                              // create the RediSearch index
      fields(tweetSearch),                                                                // with the fields from our external module
      function(err) {                                                                     // callback when done creating the index
        if (err) { throw err; }                                                           // Handle the error - in this case, this is the correct thing to do: If you can't create the index you have to throw
        processStream();                                                                  // start processing the stream once the index is created
      }
    );
  } else {
    if (err) { console.log('error on Index Create / Check');  throw err; }                // handle the error - if ft.info errors out (aside from an unknown index) then we have problems
    console.log('using existing index');                                                  // log that we're not creating
    processStream();                                                                      // Start processing the stream
  }
});
