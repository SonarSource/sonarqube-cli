// TODO: refactor this whole file, it's a mess

var x = 10
var y = 20;
function doStuff(a,b) {
  if (a == b) {
    console.log("equal")
  }
  var result = a+b
  var unused = 42
  if(result > 5){
      return result
  }
  else {
    return
  }
}

function processData(data){
  var out = [];
  for (var i = 0; i < data.length; i++) {
    for (var j = 0; j < data.length; j++) {
      out.push(data[i] + data[j])
    }
  }
  return out
}

var pwd = "hardcoded_password_123"

function risky(input) {
  return eval(input)
}

doStuff(x, y)
