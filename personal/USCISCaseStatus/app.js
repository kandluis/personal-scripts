/*
* @Author: Luis Perez
* @Date:   2016-08-24 16:12:46
* @Last Modified by:   Luis Perez
* @Last Modified time: 2016-08-28 11:48:00
*/

'use strict';

var _ = require('lodash')
  , async = require('async')
  , assert = require('assert')
  , debug = require("debug")("USCIS:app")
  , moment = require("moment")
  , fs = require("fs")
  , htmlparser = require("htmlparser")
  , json2csv = require("json2csv")
  , request = require('request')
  , select = require("soupselect").select;

var argv = require('yargs')
  .usage("Usage $0 -p IOE -n 0900677923 -t 1 -l 10 -o out.csv")
  .help('h')
  .describe("p", "The prefix used for the case numbers.")
  .describe("n", "The case number from which to start the search.")
  .describe("t", "The total number of cases to query.")
  .describe("l", "The total number of request to make at once.")
  .describe("o", "The output file name")
  .demand(["p", "n"])
  .number("n")
  .number("t")
  .number("l")
  .default({
    p: "IOE",
    n: "0900677923",
    t: 1,
    l: 10
  })
  .alias("p", "prefix")
  .alias("n", "case-number")
  .alias("t", "total")
  .alias("l", "limit")
  .alias("h", "help")
  .argv;

// GLOBALS
// DETECT IP BLOCK
var BLOCKED = false;

// ACCUMULATE RESULTS FOR EVENTUAL GRACEFUL SHUTDOWN
var results = [];

// On Ctrl-C, for graceful shutdown!
process.on( 'SIGINT', function() {
  console.log( "\nGracefully shutting down from SIGINT (Ctrl-C)" );

  // Done for the side-effects!
  utils.processFinalResults(results);

  process.exit(0);
})

var Const = {
  maxFailures: 100,
  url: "https://egov.uscis.gov/casestatus/mycasestatus.do",
  method: "POST",
  formDataDefaults: {
    changeLocal: null,
    completedActionsCurrentPage: 0,
    upcomingActionsCurrentPage: 0,
    caseStatusSearchBtn: "CHECK STATUS"
  },
  selectors: {
    main: "div.rows",
    type: "h1",
    text: "p"
  },
  caseNumLength: 10
};

// Maps USCIS case status to local types.
var titleToType = {
  "Biometrics Appointment Was Scheduled": "BIO",
  "Case Was Received and A Receipt Notice Was Emailed": "NOTICE",
  "Decision Notice Mailed": "APPROVED",
  "Request for Additional Evidence Was Mailed": "EVIDENCE_REQUEST",
  "Card Was Delivered To Me By The Post Office": "CARD_ISSUED",
  "Interview Was Scheduled": "INTERVIEW",
  "Withdrawal Acknowledgement Notice Was Sent": "WITHDRAWN",
  "Notice Explaining USCIS' Actions Was Mailed": "EXPLAIN",
  "Card Is Being Produced": "CARD_ISSUED",
  "Case Approved": "APPROVED",
  "Case Was Approved": "APPROVED",
  "Response To USCIS' Request For Evidence Was Received": "EVIDENCE_REQUEST",
  "Card Was Produced": "CARD_ISSUED",
  "Case Was Suspended Because My Fee Was Returned by My Bank": "SUSPENDED",
  "Case Rejected Because I Sent An Incorrect Fee": "REJECTED"
};

var utils = {
  pad: function(num, size) {
    var s = num + "";
    while (s.length < size) {
      s = "0" + s;
    }
    return s;
  },

  extract: function(dom, selector){
    var data = select(dom, selector);
    if (data.length !== 1){
      debug("wrong data length! expected 1!", data);
      return null;
    }
    var tmpdata = data[0].children;
    if(tmpdata){
      if(tmpdata.length === 0){
        debug("wring data lenght! expected > 1", tmpdata)
        return null;
      }
      return tmpdata[0].data;
    }

    debug("undefined data. parent:", data);
    return null;
  },

  getDate: function(data){
    var date;
    try{
      var seperated = data.split(",");
      var dateString = seperated.slice(0,2).join(", ");
      dateString = dateString.slice(3, dateString.length);
      date = moment(dateString, "MMM DD  YYYY");
    } catch(e){
      date = moment();
    }

    return {
      date: date,
      string: date.format("dddd, MMMM Do YYYY")
    }
  },

  infoParser: function(text, title) {
    function getType(key){
      if (_.has(titleToType, key)){
        return titleToType[key];
      }
      else{
        console.log("unknown key", key);
        return "UNKNOWN"
      }
    };

    return {
      data: {
        raw: text,
        heading: title
      },
      type: getType(title),
      date: utils.getDate(text)
    }
  },

  /**
   * Extraction of key information has failed. Attempts to determine
   * the reason for this failure.
   * @param  {Object} dom - HTML DOM of page with error.
   * @return {String}     - One of {"UNKNOW", "BLOCKED", or "NOT_FOUND"}
   */
  getErrorType: function(dom){
    // check for <label for="accessviolation";
    var label = select(dom, "label");
    var labelFor = _.get(label, "0.attribs.for", null);
    if (labelFor == "accessviolation"){
      return "BLOCKED";
    }

    if (labelFor == "receipt_number"){
      var error = select(dom, "#formErrorMessages h4");
      var msg = _.get(error, "0.children.0.raw").split(" ");
      if (msg[0] == "Validation"){
        return "NOT_FOUND";
      }
    }

    console.log("unknown error type", label);
    return "UNKNOWN";
  },

  /**
   * Extracts the information for each case from the raw HTML retrieved.
   * @param  {String} [rawHTML] - Raw HTML of the page.
   */
  extractInfo: function(rawHTML, callback){
    // console.log(rawHTML);
    var handler = new htmlparser.DefaultHandler(function(err, dom){
      if(err){
        console.log("error parsing page");
        return callback(err);
      }

      var titleSelector = [Const.selectors.main, Const.selectors.type].join(" ");
      var textSelector = [Const.selectors.main, Const.selectors.text].join(" ");
      var title = utils.extract(dom, titleSelector);
      var text = utils.extract(dom, textSelector);
      if(!title || !text){
        debug("initial extraction failed! attempt salvage!");

        var type = utils.getErrorType(dom);
        return callback({
          type: type,
          msg: "info extraction failed"
        });
      }
      return callback(null, utils.infoParser(text, title));
    });

    var parser = new htmlparser.Parser(handler);
    parser.parseComplete(rawHTML);
  },

  /**
   * Retrieves an object of information pertinent to the specified case.
   * @param  {String} [case] - The case number, in string format, to be used to check the USCIS site.
   */
  retrieveCaseStatus: function(caseNum, callback){
    var formData = _.extend({}, Const.formDataDefaults, {
      appReceiptNum: caseNum
    });
    request.post({
      rejectUnauthorized: false,
      url: Const.url,
      form: formData,
      headers: {
        UpgradeInsecureRequests: 1
      }
    }, function(err, res){
      var defaultReturn = {
        caseNum: caseNum,
        type: "FAILED",
        date: utils.getDate(),
        data: {}
      };

      if(err){
        console.log("initial retrieval failed for case", caseNum);
        debug(err);
        return callback(null, defaultReturn);
      }

      return utils.extractInfo(res.body, function(err, res){
        if(err){
          if(err.type == "BLOCKED"){
            BLOCKED = true;
          }
          else if (err.type == "NOT_FOUND"){
            console.log(caseNum, "does not exists!");
            defaultReturn = _.extend({
              type: "NEXIST"
            });
          }

          return callback(null, defaultReturn);
        }
        return callback(null, _.extend({}, defaultReturn, res, {
          caseNum: caseNum
        }));
      });
    });
  },

  /**
   * Groups the result array into a single object by date buckets using res[].date.string and within each bucket groups by type using res[].type.
   * @param  {Array} res - The input objects.
   * @return {Object}     A object mapping dates to Array of objects.
   */
  group: function(res){
    var res2 = _.reduce(res, function(acc, item){
      var date = _.get(item, "date.date", moment());
      var dateString = _.get(item, "date.string", moment().format("dddd, MMMM Do YYYY"));
      var type = _.get(item, "type", "UNKNOWN");

      var path = dateString + "." + type;
      var value = _.get(acc, path, {
        items: [],
        total: 0,
        type: type,
        date: dateString,
        unix: date.unix()
      });
      value.items.push(item);
      value.total++;
      return _.set(acc, path, value);
    }, {});

    return res2;
  },

  writeStats: function(groups){
    // sort them by date for display purposes!
    var sortedGroups = _.sortBy(_.map(groups, function(value, key){
      return _.extend(value, {
        _metadata: {
          dateString: key,
          unix: moment(key, "dddd, MMMM Do YYYY").unix()
        }
      });
    }), function(item){
      return _.get(item, '_metadata.unix');
    });

    _.forEach(sortedGroups, function(types){
      var date = _.get(types, '_metadata.dateString');
      console.log("Statistics for", date);
      _.forEach(types, function(data, type){
        if (type !== "_metadata"){
          console.log("\tApplications of Type:", type);
          console.log("\t\tTotal count:", data.total);
        }
      });
      console.log("***************************")
    });
  },

  /**
   * The name indicates what it does.
   * @param  {Array} res - Final array of accumulated results!
   * @return {Object}     Hash-table groupings
   *
   * @see Side-effects of output files and console.log!
   */
  processFinalResults: function(res){
    if(res.length > 0){

      // write out results based on time of day
      var outfile = moment().unix();
      var outData = _.sortBy(_.map(res, function(item){
        var date = _.get(item, "date.date", moment());
        var dateString = _.get(item, "date.string", moment().format("dddd, MMMM Do YYYY"));
        var type = _.get(item, "type", "UNKNOWN");

        return {
          Date: dateString,
          "Unix Time": date.unix(),
          Type: type,
          "Case Number": _.get(item, "caseNum")
        };
      }), _.partial(_.get, _, 'Unix Time'));
      var outCSV = json2csv({ data: outData });
      fs.writeFile("temp_" + outfile + ".csv", outCSV, function(err){
        if (err){
          console.log("failed to save file", err);
        }
      });

      // group by date > type
      var groups = utils.group(res);
      debug("grouped", groups);

      // Write output to file if specified
      if (argv.o){
        var csvData = _.sortBy(_.flatten(_.map(_.values(groups), function(item){
          return _.map(_.values(item), function(_item){
            var dateString = _.get(_item, "date", moment().format("dddd, MMMM Do YYYY"));
            var type = _.get(_item, "type", "UNKNOWN");
            var unixTime = _.get(_item, "unix", moment().unix());

            return {
              Date: dateString,
              "Unix Time": unixTime,
              Type: type,
              Applications: _.get(_item, "total", 0)
            };
          });
        })), function(item){
          return _.get(item, "Unix Time");
        });

        if (csvData.length > 0){
          var csv = json2csv({ data: csvData });
          fs.writeFile(argv.o, csv, function(err){
            if (err){
              console.log("failed to save file", err);
            }
          });
        }
      }

      // write out the grouped statistics to console
      utils.writeStats(groups);

      return groups;
    }

    // no results
    return {};
  },

  recursiveHelper: function(data, current, acc, callback){
    // copy the acc value over to a global so we can do
    // a graceful shutdown
    results = acc;

    var prefix = _.get(data, 'prefix')
      , end = _.get(data, 'end')
      , intervalSize = _.get(data, 'intervalSize');

    if(current >= end || BLOCKED){
      if(BLOCKED){
        console.log("\n\nERROR: IP has been blocked!\n\n");
      }
      return callback(null, acc);
    }

    var params = utils.getParams(prefix, current, intervalSize);
    var startTime = moment();
    console.log("Processing of cases starting at", current, "...");

    async.map(params, utils.retrieveCaseStatus, function(err, res){
      var newCurrent = current + intervalSize;
      var secondsPassed = (moment().unix() - startTime.unix());
      console.log("Finished calls of cases up to", newCurrent, "in a total of", secondsPassed, "seconds.");
      var fn = _.partial(utils.recursiveHelper, data, newCurrent, _, callback);
      if(err){
        // ignore errors
        return fn(acc);
      }

      return fn(_.concat(acc, res));
    });
  },

  /**
   * Retrieves parameters for retrieveCaseStatus function
   * @param  {String} prefix - Case status prefix.
   * @param  {Number} start  - Beginning case number.
   * @param  {Number} number - Total cases to query.
   * @return {Array}        - Array of params.
   */
  getParams: function(prefix, start, number){
    return _.times(number, function(index){
      return prefix + utils.pad(_.add(parseInt(start), index), Const.caseNumLength);
    });
  }
};

var options = {
  total: argv.t,
  prefix: argv.p,
  start: argv.n,
  limit: argv.l,
  outfile: argv.o
};

/**
 * Exported api. Note that this writes out the successful results from a single run to a csv.
 * @param  {Object} options - The options object.
 * @param {Number} options.total - The total number of cases to sequentially query.
 * @param {String} options.prefix - The case prefix. eg IOE, NSC, etc.
 * @param {Number} options.start - The case number from which to start the data collection.
 * @param {Number} options.limit - The number of asynchronous calls to make.
 * @param {String} options.outfile - The file to which the aggregate results should be output.
 * @param {Function} callback - final node-style callback.
 * @return {[type]}         [description]
 */
function run(options, callback) {
  console.log("Starting...\n");

  var start = parseInt(options.start);
  var data = {
    prefix: options.prefix,
    intervalSize: parseInt(options.limit),
    end: start + parseInt(options.total)
  };

  return utils.recursiveHelper(data, start, [], function(err, res){
    console.log("\nCompleted all results! total of", res.length);
    console.log("Starting final processing!\n");
    var start = moment().unix();
    var hash = utils.processFinalResults(res);
    var end = moment().unix();
    console.log("\nCompleted final processing in", end-start, "seconds.");
    callback(err, hash);
  });
}

var options = {
  total: argv.t,
  prefix: argv.p,
  start: argv.n,
  limit: argv.l,
  outfile: argv.o
};

run(options, function(err, res){
  if(err){
    console.log(err);
  }
});
