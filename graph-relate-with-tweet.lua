local function isempty(s)
  return s == nil or s == ''
end
local function user_exists_query(user) 
  return "MATCH (u:User) WHERE u.screen_name = \"" .. user .. "\" RETURN u.screen_name";
end
local function create_user(user) 
  return "CREATE (:User { screen_name: \"" .. user .. "\" })";
end
local function create_tweet(tweetId) 
  return "CREATE (:Tweet { id : \"" .. tweetId .. "\" })";
end
local function create_interaction(user,tweetId) 
  return "MATCH (a:User),(b:Tweet) WHERE a.screen_name = \"" .. user .. "\" AND b.id = \"" .. tweetId .. "\" CREATE (a)-[:MENTIONED_IN]->(b)";
end


local status = {};

local argv_count = 0;
local mention_count = 1;
local create_count = 0;
local tweetId = ARGV[1];

redis.call('graph.query', KEYS[1], create_tweet(tweetId));
local interactions = {};


for _ in pairs(ARGV) do 
  argv_count = argv_count + 1;

  if (argv_count ~= 1) then
    mention_count = mention_count + 1;
    
    -- check if the user already exists
    local user = ARGV[mention_count];
    local user_exists = redis.call('graph.query', KEYS[1], user_exists_query(user));
    -- in not, create
    if (isempty(user_exists[1][2])) then
      redis.call('graph.query', KEYS[1], create_user(user))
      create_count = create_count + 1;
    end
    table.insert(interactions, redis.call('graph.query',KEYS[1],create_interaction(user,tweetId))); 
  else 
    table.insert(status, 'ignore ' .. ARGV[argv_count]);
  end
end
table.insert(status, 'tweetId');
table.insert(status, tweetId);
table.insert(status, 'mentions');
table.insert(status, mention_count);
table.insert(status, 'created');
table.insert(status, create_count);
table.insert(status, 'interactions');
table.insert(status, interactions);


return status;