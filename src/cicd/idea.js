

function fetchRepo(...) {

    osiframework.<cosas>...

    return repoLocalContext;
}

function buildRepo(repoLocalContext) {
    osiframework.<cosas>...
    return localContainerImageRef;
}

function pushImage(localContainerImageRef) {
    osiframework.<cosas>...
    return imageRef;
}

// pipeline definition

function aPipeline(gitCommitData) {
 
    return osiframework.buildPipeline([
        fetchRepo,
        buildRepo,
        pushImage,
        osiframework.manualConfirmation(xxx, yyy, zzz),
        ... etc
    ] );
    

}

// pusb 
on('<<gitCommitHookAlgo>>', req, {
    osiframework.launch( aPipeLine(req.gitCommitData);
});

