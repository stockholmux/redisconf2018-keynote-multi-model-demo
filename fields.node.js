/* a simple module just to hold our schema for RediSerarch */
module.exports = function(search) {                                                       // export the fields only, inject the search object so we have a pure function
  return [
    search.fieldDefinition.text('screen_name'),                                           // text field for the twitter screen name
    search.fieldDefinition.text('tweet_text'),                                            // text field for the text of the tweet
    search.fieldDefinition.tag('mentions'),                                               // mentions as a tag field (CSV-ish)
    search.fieldDefinition.tag('urls')                                                    // urls as a tag field (CSV-ish)
  ];
};