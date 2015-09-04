'use strict';

let gulp = require('gulp');
let babel = require('gulp-babel');
let es = require('event-stream');

let babelOptions = {
  loose: 'all',
  modules: 'amd',
};

gulp.task('default', ['zone.js']);

gulp.task('zone.js', function() {
  return gulp.src('node_modules/zone.js/dist/zone-microtask.js')
    .pipe(gulp.dest('vendor/'));
});
