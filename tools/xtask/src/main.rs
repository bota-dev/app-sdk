fn main() {
    // The executable name is discarded by skip(1); only explicit xtask arguments reach its parser.
    // nosemgrep: rust.lang.security.args-os.args-os
    if let Err(error) = xtask::run(std::env::args_os().skip(1)) {
        eprintln!("xtask: {error}");
        std::process::exit(1);
    }
}
