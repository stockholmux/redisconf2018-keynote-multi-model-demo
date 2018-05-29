/*jslint
  node, multivar, white, single, long
*/
const
  argv              = require('yargs')                                                    // "yargs" is a command line argument module
                      .demand('connection')                                               // 'connection' is the path to the node_redis style connection object
                      .argv,                                                              // return it as a plain object
  emojiRegex        = require('emoji-regex')(),                                           // regex for emoji :sigh:
  redis             = require('redis'),                                                   // node_redis library
  connection        = require(argv.connection),                                           // take the passed path and include it a file
  _                 = require('lodash'),                                                  // lodash functionalish toolkit
  sw                = require('stopword'),                                                // generic stopword list
  streamProcessor   = require('./streamProcessor.node.js'),                               // our stream processing framework
  rKeys             = {                                                                   // our keys
    wordcloud     : 'wordcloud',
    tweets        : 'tweets'
  };

redis.add_command('xadd');                                                                // add in `xadd`,`xrange`, and `xread` because they're pre-prelease commands not in the library
redis.add_command('xrange');
redis.add_command('xread');
/* How this works:
   Read a range of data from the stream with XREAD (every n seconds). 
   The words of the tweet are split up and put into a sorted set with
   each member being a word, and count being the frequency in this batch of tweets (using ZINRCBY).
   Then we back the frequencies with ZREVRANGE fetching only the top 10. 
   This is pushed out through a websocket to the client
   The zset is unlinked before each batch.*/

let 
  client = redis.createClient(connection),                                                // create our client for redis
  controlPlaneClient = client.duplicate(),                                                // since we're using streams, we'll need two clients (blocking)
  last = Date.now();                                                                      // init the first timestamp

function _addToWordCloud(client,words,cb) {                                               // the source of the partially applied command
  "use strict";
  let args = ['word-cloud-stream','MAXLEN','1000','*'];                                   // our key, the max length of the stream, and just add to the next
  args = args.concat(_(words)                                                             // add in the new words
    .map((word,i) => [i,word])                                                            // for each word and index. We reverse it so we get a ranked listed like [_rank_,_word_]
    .flatten()                                                                            // flatten this out into a single depth array
    .value()                                                                              // now we just the normal array out
  );
  client.xadd(args,cb);                                                                   // We can pass back directly into a stream
}
let addToWordCloud = _.partial(_addToWordCloud, client);                                  // use partial so we can just execute with the words and callback
let paused = true;                                                                        // start in a paused state
let elementProcessors = {                                                                 // element processor object
  'control-plane-cloud'   : (element) => function(done) {                                 // respons to the `control-plane-cloud` stream
    let 
      dataObj = _(element[1]).chunk(2).fromPairs().value();                               // get the values from the stream out

    if (dataObj.activate === 'true') {                                                    // activate the word cloud
      paused = false;                                                                     // no longer paused
    } else if (dataObj.activate === 'false') {
      paused = true;                                                                      // paused
    }
    done();
  }
};
streamProcessor(controlPlaneClient,Object.keys(elementProcessors),elementProcessors);     // Start processing the stream

function generateWordCloud() {                                                            // this will generate the word cloud from input
  "use strict";
  let currentLast = last;                                                                 // we'll generate a new last next timestamp in the next line
  last = Date.now();                                                                      // new timestamp
  
  client.xrange(                                                                          // get an between the currentLast and whatever the server has
    rKeys.tweets,                                                                         // at our key
    currentLast+'.0',                                                                     // between the last time
    '+',                                                                                  // and current
    function(err, data) {
      if (err) { throw err; }                                                             // handle errors (poorly)
      if (data) {                                                                         // did anything come through?
        let words = _(data)                                                               // start a lodash pipeline
          .map(function(aStreamResponse) {                                                // process each streamResponse
            let 
              t = aStreamResponse[1],                                                     // the tweet obj
              tweet = t[5],                                                               // the actual tweet text
              mentions = t[7],                                                            // mentions in the tweet
              urls = t[9];                                                                // any urls in the tweet.
            
            // we need to clean up the word cloud - remove tweets and mentions
            mentions = mentions.split(',');                                               // convert the csv back to an array                    
            mentions.forEach(function(aMention) {                                         // take the mentions and...
              tweet = tweet.replace(aMention,'');                                         // remove them from the tweet
            });

            urls = urls.split(',');                                                       // conver the csv of the urls back to an array
            urls.forEach(function(aUrl) {                                                 // take the urls and...
              tweet = tweet.replace(aUrl,'');                                             // remove them from the tweet 
            });

            tweet = tweet.replace(/[\u2018\u2019'][a-z]{1,2}/gi,'');                      // remove single quote marks (which twitter seems to insert)
            tweet = tweet.replace(emojiRegex,'');                                         // remove the emjoi - they don't look good in a word cloud

            let tweetArr = _(tweet.toLowerCase())                                         // now take the remaining tweet, lower case it and in it goes to a lodash pipeline
              .words()                                                                    // split out the words
              .filter((e) => e.length > 1)                                                // no single letter words, they don't look right
              .pullAll(['rt','https','amp','co','http'])                                  // some common junk that gets caught up in tweets, remove it.
              .value();                                                                   // now we have a pure array of words from a tweet

              return sw.removeStopwords(tweetArr);                                        // return back the an array of words
          })
          .flatten()                                                                      // we have to flatten because of multiple tweets
          .value();                                                                       // finally we get a array of of clean words over multiple tweets
        let freqMulti = client.multi();                                                   // start a `MULTI`/`EXEC` transaction
        if (words.length > 1) {                                                           // do we have more than one word (not much of a word cloud otherwise)
          freqMulti.unlink(rKeys.wordcloud);                                              // remove the last word cloud data source
          words.forEach(function(aWord) {                                                 // for each word do a single command...
            freqMulti.zincrby(rKeys.wordcloud,1,aWord);                                   // ...ZINCRBY 
          });
          freqMulti.exec(function(err) {                                                  // execute the (very large, but efficient) transaction
            if (err) { throw err; }                                                       // handle errors (poorly)

            client.zrevrange(rKeys.wordcloud,0,20,'WITHSCORES',function(err,results) {    // once done, get the list back in reverse order along with the scores
              if (err) { throw err; }                                                     // handle errors (poorly)
              addToWordCloud(                                                             // add to the word cloud
                _(results)                                                                // take the results and put them into a lodash pipeline
                  .chunk(2)                                                               // make them into even/odd paris
                  .map((p) => p[0]+'/'+p[1])                                              // return them back as `[score]/[word]`
                  .value()                                                                // return the value into the argument
                ,                                                               
                function(err) {                                                           // addToWordCloud callback
                  if (err) { throw err; }                                                 // handle errors (poorly)
                });
            });
          });
        }
      }
    }
  );
}
setInterval(function() {                                                                  // every 1000 ms...
  "use strict";
  if (!paused) {                                                                          // if we aren't paused...
    generateWordCloud();                                                                  // generate the word cloud...
  } else {                                                                                // if we are paused do...
    console.log('Paused');                                                                // practically nothing
  }
},1000);