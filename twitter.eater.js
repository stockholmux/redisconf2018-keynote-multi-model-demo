/*jslint
  node, multivar, white, single
*/
const
  argv          = require('yargs')                                  // "yargs" is a command line argument module
                  .demand('connection')                             // 'connection' is the path to the node_redis style connection object
                  .demand('twittercreds')                           // Path to JSON file containing Twitter API credentials
                  .demand('terms')                                  // comma delimited keywords to track (e.g. "nodejs,angular,redis")
                  .argv,                                            // return the values in an object
  _             = require('lodash'),                                // We'll use lodash to make sorting and filtering the most idle connections easier
  redis         = require('redis'),                                 // node_redis to manage the redis connection
  Twitter       = require('node-tweet-stream'),                     // Get tweets in an evented stream

  twitterCreds  = require(argv.twittercreds),                       // Load the twitter credentials from the JSON file
  connectionJson
                = require(argv.connection),                         // Load the connection object from a file

  t             = new Twitter(twitterCreds),                        // create the twitter stream instance

  client        = redis.createClient(connectionJson),               // create the redis client, used for pushing out consolidated tweets to the stream
  controlPlaneClient
                = client.duplicate(),                               // create a second connection to prevent cross blocking stream clients
  streamProcessor   
                = require('./streamProcessor.node.js');             // stream processing framework

let 
  paused        = true,                                             // keep track of pause state
  perSec        = 0;                                                // keep track of the number of tweets per second

redis.add_command('xread');                                         // since streams are not GA, we'll need to add in these commands to allow client level access
redis.add_command('xadd');

t.on('tweet', function (tweet) {                                    // node-tweet-stream emits a 'tweet' event when one comes in
  "use strict";
  if (!paused) {                                                    // basically do nothing if we're paused
    perSec += 1;                                                    // inc our tweet flow monitor
    let 
      tweetEntities = tweet.entities,                               // sugar
      mentions = tweetEntities.user_mentions
        .map((mention) => mention.screen_name)                      // extract mentions
        .join(','),                                                 // results in a comma delimited list of screen names mentioned
      urls = tweetEntities.urls           
        .map((aUrlEntity) => aUrlEntity.url)                        // extract URL
        .join(',');                                                 // results in a comma delimited list of URLs
    client.xadd('tweets',                                           // add to the stream `tweets`
      '*',                                                          // at the latest sequence
      'id',tweet.id_str,                                            // stream field `id` with the tweet id (in string format because JS is bad with big numbers!)
      'screen_name',tweet.user.screen_name,                         // stream field `screen_name` with the twitter screen name
                                                                    // stream field `text` with either the extended (>140 chars), if present, or normal if (<140 chars)
      'text',(tweet.extended_tweet && tweet.extended_tweet.full_text) ? tweet.extended_tweet.full_text : tweet.text,
      'mentions',mentions,                                          // stream field `mentions` with the mentions comma delimited list
      'urls',urls,                                                  // stream field `urls` with urls comma delimited list
      function(err) {
        if (err) { throw err; }                                     // handle any errors - a production service would need better error handling.
      }
    );
  }
  
});



setInterval(function() {                                            // simple interval to respond incoming tweets per second
  "use strict";
  console.log('Tweets per/sec',perSec);
  perSec = 0;                                                       // reset the counter
},1000);                                                            // The tweets per second is not exact because interval isn't either

t.on('error', function (err) {                                      // Handle errors, just in case.
  "use strict";
  console.error('Twitter Error', err);                              // Twitter does have quite a few limits, so it's very possible to exceed them
});                                                                 // I discovered that the twitter stream module is not robust - dropped connections may not result in errors being thrown. Use with caution.

argv.terms.split(',').forEach(function(aTerm) {                     // Split up the tracking argument from the command line
  "use strict";
  console.log('tracking',aTerm);                                    // log what we're tracking
  t.track(aTerm);                                                   // Track the keyword
});

let elementProcessors = {                                           // Element processor pattern. This listens to stream (control-plane-eater) with `xread` for a events
  'control-plane-eater'   : (element) => function(done) {           // the element is the output from redis
    let 
      dataObj = _(element[1]).chunk(2).fromPairs().value(),         // grab the data which is in interleaved array format (field, value, field value, ....) and convert to pairs and create an object out of it.
      activate = dataObj.activate;                                  // I really just need the `activate` property

    if (activate === 'true') {                                      // I had some variable coercion issues with using 0/1, so using string true and string false
      paused = false;                                               // no longer paused
      console.log('Activate twitter');
    } else if (activate === 'false') {
      paused = true;                                                // in paused mode. Note that this doesn't survive a restart - it would be better to store this state in Redis itself
      console.log('Deactivate twitter');
    }
    done();                                                         // note that we're done and we can listen again.
  }
};

streamProcessor(controlPlaneClient,Object.keys(elementProcessors),elementProcessors);