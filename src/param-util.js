'use strict'

const debug = require('debug') ('vapor-master:param-util')
const updateUtil = require('./update-util.js')
const topicUtil = require('./topic-util.js')

// remove all param & param sub docs & resolve to # removed
exports.clean = async (db) => {
  const found = await Promise.all([
    db.Vapor.param.find().exec(), // get all params
    db.Vapor.paramSub.find().exec(), // get all param subscribers
  ])

  const removed = []
  for (const docs of found) {
    for (const doc of docs) {
      removed.push(doc.remove()) // init remove & collect promise
    }
  }

  await Promise.all(removed) // wait for remove operations to resolve
  return removed.length // return # removed
}

// get most recent param at exact key path
// ***not consistent with get()!***
exports.getByKey = (db, keyPath) => {
  const path = (keyPath[keyPath.length - 1] === '/') ? keyPath : keyPath + '/'
  return db.Vapor.param.findOne()
    .sort('-created').where('keyPath').equals(path).exec()
}

// get all params
exports.getAllKeys = async (db) => {
  const params = await db.Vapor.param.find().exec()

  const keys = {}
  for (const param of params) {
    keys[param.keyPath.slice(0, -1)] = true // drop trailing slash
  }
  return Object.keys(keys)
}

// find all params matching subpath ordered from oldest to newest
exports.getBySubpath = (db, subpath) => {
  const re = topicUtil.subpathRegEx(db, subpath)

  return db.Vapor.param.find()
    .sort('created').where('keyPath').regex(re).exec()
}

//resolves parameter paths for local or private scope
exports.resolvePath = (keyPath, callerPath) =>{
  let path = keyPath
  let re = /(\/.*)+\/.+[\/]?$/
  
  //resolves local scope (i.e. 'param1' at '/en/node' resolves to '/en/param1')
  if (keyPath[0] != '/' && keyPath[0] != '~'){
    path = '/' + keyPath
    const matches = callerPath.match(re)
    if (matches) {
      path = matches[1] + path
    }
  }
  // assure key path has trailing slash
  path = (path[path.length - 1] === '/') ? path : path + '/'

  //resolves private scope
  if (path[0] == '~'){
    path = callerPath + '/' + path.substring(1,path.length)
  }
  return path;
}

// find all params matching subpath and load them into a dictionary
// load oldest params first so that newer values overwrite older values
exports.get = async (db, callerPath, keyPath) => {
  const path = exports.resolvePath(keyPath, callerPath);
  // get path steps without leading & trailing empty spaces from slashes
  const steps = path.split('/').slice(1, -1)

  // getBySubpath delivers params sorted oldest -> newest
  // build param tree by assigning params to dict in order so that newer
  // params clobber older params
  const params = await exports.getBySubpath(db, path)
  const tree = {}
  
  debug('get', keyPath)
  debug('params', JSON.stringify(params,null,2))

  for (const param of params) {

    // handle special case of root path query ('/') which gives 0 steps
    // * for root query keep all steps of parameter key path (except slashes)
    // * for other queries start at last step of query path so leaf values
    //   will be captured properly
    const keys = (steps.length === 0) ? param.keyPath.split('/').slice(1, -1)
      : param.keyPath.split('/').slice(steps.length, -1)

    //debug(JSON.stringify(keys))

    let subtree = tree // start subtree at top level
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i]

      // assign value to last key
      if (i === keys.length - 1) {
        subtree[key] = param.paramValue()

      // start at last step of query path (to capture top level leaf values)
      // iteratively fetch next level in subtree
      // * build it if its not there
      // * if there is a leaf value clobber it with an object for subtree
      } else {
        if (!(key in subtree) || typeof subtree[key] !== 'object') {
          subtree[key] = {}
        }
        subtree = subtree[key]
      }
    }
  }

  debug(steps)
  debug('tree', JSON.stringify(tree,null,2))

  // unless query path was '/' value is keyed with last step of query
  return (steps.length === 0) ? tree : tree[steps[steps.length - 1]]
}

// create new param sub & write to backend -> returns promise
exports.createSub = (db, keyPath, subPath, subUri, subIP) => {
  const path = (keyPath[keyPath.length - 1] === '/') ? keyPath : keyPath + '/'
  return db.Vapor.paramSub.create({
    keyPath: path,
    subscriberPath: subPath,
    subscriberUri: subUri,
    subscriberIpv4: subIP
  })
}

// resolves to list of deleted xubs
exports.removeSub = async (db, keyPath, subPath, subUri) => {
  const path = (keyPath[keyPath.length - 1] === '/') ? keyPath : keyPath + '/'

  const subs = await db.Vapor.paramSub.find()
    .where('keyPath').equals(path)
    .where('subscriberPath').equals(subPath)
    .where('subscriberUri').equals(subUri).exec()

  const removed = []
  for (const sub of subs) {
    removed.push(sub.remove()) // init parallel backend removal of matches
  }
  if (removed.length > 1) {
    console.log(
      `WARNING: removed multiple subs at '${subPath}' for param '${path}'`)
  }

  return Promise.all(removed) // resolve parallel backend removes
}

exports.removeByKey = async (db, callerPath, keyPath) => {
  const path = exports.resolvePath(keyPath, callerPath)

  const params = await db.Vapor.param.find()
    .where('keyPath').equals(path).exec()

  const removed = []
  for (const param of params) {
    removed.push(param.remove()) // init parallel backend removal of matches
  }
  if (removed.length > 1) {
    console.log(`WARNING: removed multiple params at '${path}'`)
  }
  return Promise.all(removed) // resolve parallel backend removes
}

exports.setByKey = (db, keyPath, value, creatorPath, creatorIpv4) => {
  const valueType = (value === null) ? 'null' :  ((Array.isArray(value)) ? 'array' : typeof value )

  const updateQuery = {
    keyPath: keyPath
  }

  const options = {
    upsert: true
  }

  switch (valueType) {
    case 'string':
      if (value == ""){
        debug("stringValue is equal to an empty string!")
      }
      return db.Vapor.param.findOneAndUpdate(
        updateQuery,
        {
          keyPath: keyPath,
          valueType: valueType,
          stringValue: value,
          creatorPath: creatorPath,
          creatorIpv4: creatorIpv4
        },
        options
      )
    case 'number':
      return db.Vapor.param.findOneAndUpdate(
        updateQuery, 
        {
          keyPath: keyPath,
          valueType: valueType,
          numberValue: value,
          creatorPath: creatorPath,
          creatorIpv4: creatorIpv4
        },
        options
      )
    case 'boolean':
      return db.Vapor.param.findOneAndUpdate(
        updateQuery,
        {
          keyPath: keyPath,
          valueType: valueType,
          booleanValue: value,
          creatorPath: creatorPath,
          creatorIpv4: creatorIpv4
        },
        options
      )
    case 'array':
      return db.Vapor.param.findOneAndUpdate(
        updateQuery,
        {
          keyPath: keyPath,
          valueType: valueType,
          arrayValue: value,
          creatorPath: creatorPath,
          creatorIpv4: creatorIpv4,
        },
        options
      )
  }

  // null value only has valuetype set
  return db.Vapor.param.findOneAndUpdate(
    updateQuery,
    { 
      keyPath: keyPath,
      valueType: valueType,
      creatorPath: creatorPath,
      creatorIpv4: creatorIpv4
    },
    options
  )
}

// recursively sets value at path until leaf (!object) value reached
// * on success makes xmlrpc calls to update any subscribers
// * backend stores doc for each key path / leaf value pair
// * setting a map with multiple k/v pairs generates a doc for each value
//   - set('/foot/left/sock', 'green', ..) &
//   - set('/foot/left', {sock: 'green'}, ..)
//   produce identical results -- a single new backend doc
//   -> Param{ keyPath: '/foot/left/sock', value: 'green', ..}
exports.set = async (db, keyPath, value, creatorPath, creatorIpv4) => {

  const path = exports.resolvePath(keyPath, creatorPath);

  debug('set ' + keyPath)
  // null, strings, numbers & booleans can be leaf values
  if (value === null
      || typeof value === 'string'
      || typeof value === 'number'
      || typeof value === 'boolean') {

    debug('set typeof value is ', typeof value)
    const params = await exports.getBySubpath(db, path);
    //clobber path
    if (params && params){
      for (let param of params){
        await param.remove()
      }
    }
    await exports.setByKey(db, path, value, creatorPath, creatorIpv4)

  // for object make recursive call for each [subkey, subvalue] pair
  } else if (typeof value === 'object') {

    if(Array.isArray(value)){
      debug('set typeof value is array')
      const params = await exports.getBySubpath(db, path);
      //clobber path
      if (params){
        for (let param of params){
          await param.remove()
        }
      }
      await exports.setByKey(db, path, value, creatorPath, creatorIpv4)
    } else {
      //if object is empty dictionary, just clobber the path
      if (Object.keys(value).length === 0){
        debug("param set to empty dictionary!")
        const params = await exports.getBySubpath(db, path)
        //clobber path
        if (params){
          for (let param of params){
            await param.remove()
          }
        }
        await exports.setByKey(db, path, null, creatorPath, creatorIpv4)
      } else {
        // make recursive call for each subkey & await completion in parallel
        const calls = []

        for (let [ subkey, subvalue, ] of Object.entries(value)) {

          calls.push( exports.set(db, path + subkey, subvalue, creatorPath, creatorIpv4) )
        }
        await Promise.all(calls)
      }
    }

  } else {
    throw new Error(
      `cant set param of type '${typeof value}': '${value.toString()}'`)
  }

  // on success async update subs
  setImmediate(() => {
    exports.updateSubs(db, path, value)
  })
}

// check for any subscribers to key path & update
// call is asynchronous dont need to wait for promises to resolve
exports.updateSubs = async (db, keyPath, value) => {
  const subs = await exports.getSubs(db, keyPath)
  debug("number of Param subs to be updated for " + keyPath + ": " + subs.length)
  for (const sub of subs) {
    debug("Updating subscriber " + sub.subscriberPath + " to param " + keyPath + " with value " + value)
    updateUtil.updateParamSub(db, sub.subscriberUri, sub.subscriberPath, keyPath, value)
  }
}

// get subscribers to key path
exports.getSubs = (db, keyPath) => {
  const path = (keyPath[keyPath.length - 1] === '/') ? keyPath : keyPath + '/'

  return db.Vapor.paramSub.find()
    .where('keyPath').equals(path).exec()
}
