/*
* @Author: Luis Perez
* @Date:   2016-08-24 16:12:46
* @Last Modified by:   Luis Perez
* @Last Modified time: 2016-08-26 09:37:46
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

var Const = {
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

var titleToType = {
  "Biometrics Appointment Was Scheduled": "BIO",
  "Case Was Received and A Receipt Notice Was Emailed": "NOTICE",
  "Decision Notice Mailed": "APPROVED",
  "Request for Additional Evidence Was Mailed": "EVIDENCE_REQUEST",
  "Card Was Delivered To Me By The Post Office": "CARD_DELIVERED",
  "Interview Was Scheduled": "INTERVIEW",
  "Withdrawal Acknowledgement Notice Was Sent": "WITHDRAWN"
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
      return null;
    }
    data = data[0].children;
    if(data){
      if(data.length === 0){
        return null;
      }
      return data[0].data;
    }
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
        return callback({
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
        return callback(null, defaultReturn);
      }

      return utils.extractInfo(res.body, function(err, res){
        if(err){
          debug("extracting info failed for case", caseNum);
          // salvage results
          return callback(null, defaultReturn);
        }
        return callback(null, _.extend({},defaultReturn, res, {
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
    return _.reduce(res, function(acc, item){
      var path = item.date.string + "." + item.type;
      var value = _.get(acc, path, {
        items: [],
        total: 0,
        type: item.type,
        date: item.date.string,
        unix: item.date.date.unix()
      });
      value.items.push(item);
      value.total++;
      return _.set(acc, path, value);
    }, {});
  },

  writeStats: function(groups){
    _.forEach(groups, function(types, date){
      console.log("Statistics for", date);
      _.forEach(types, function(data, type){
        console.log("\tApplications of Type:", type);
        console.log("\tTotal count:", data.total);

      });
      console.log("***************************")
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
 * @param {Function} fbc - final node-style callback.
 * @return {[type]}         [description]
 */
function run(options, fcb) {
  if(options.total)
  var params = _.times(options.total, function(index){
    return options.prefix + utils.pad(_.add(parseInt(options.start), index), Const.caseNumLength);
  })

  async.mapLimit(params, options.limit, utils.retrieveCaseStatus, function(err, res){
    if(err){
      console.log(err);
    }

    if(res.length > 0){
      // write out results based on time of day
      var outfile = moment().unix();
      var outData = _.sortBy(_.map(res, function(item){
        return {
          Date: item.date.string,
          "Unix Time": item.date.date.unix(),
          Type: item.type,
          "Case Number": item.caseNum
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

      if (argv.o){
        var csvData = _.sortBy(_.flatten(_.map(_.values(groups), function(item){
          return _.map(_.values(item), function(_item){
            return {
              Date: _item.date,
              "Unix Time": _item.unix,
              Type: _item.type,
              Applications: _item.total
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

      utils.writeStats(groups);

      fcb(null, groups);
    }
    else{
      fcb("No results");
    }
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
